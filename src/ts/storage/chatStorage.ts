import { forageStorage } from "../globalApi.svelte"
import { getDatabase, type Chat, type ChatStub, type ChatOrStub, type character, isChatStub } from "./database.svelte"
import { tick } from "svelte"
import { getActiveSqlStorage } from "./sql/sqlBootstrap"
import { ensureChatMessageWindow } from "./sql/sqlRuntimeHydration"
import { beginHydration, beginHydrationApply, endHydration, endHydrationApply, isHydrationActive } from "./hydrationState"
import { flushSqlDirtyChanges, markSqlChatDirty } from "./sql/sqlPersistenceRuntime"
import { isChatGenerating } from "../process/generationState"
import { selectedCharID } from "../stores.svelte"
import { get } from "svelte/store"

// ── Stub ↔ Placeholder conversion ───────────────────────────────────────────

/**
 * Convert a ChatStub to a placeholder Chat with safe empty defaults.
 * The placeholder passes all Chat type checks so existing code works unchanged.
 * `_placeholder: true` marks it for hydration and dirty-tracking suppression.
 *
 * Key presence is preserved (mirroring chatToStub) so an explicit null from
 * the server — meaning "user cleared this field" — survives the placeholder
 * round-trip. Otherwise the next chatToStub call would emit a "remove" patch
 * op and the server merge would fall back to a stale fullChat value.
 */
export function stubToPlaceholder(stub: ChatStub): Chat {
    const placeholder: Chat = {
        message: [],
        note: '',
        name: stub.name,
        localLore: [],
        id: stub.id,
        fmIndex: -1,
        _placeholder: true,
    }
    if ('lastDate' in stub) placeholder.lastDate = stub.lastDate
    if ('folderId' in stub) placeholder.folderId = stub.folderId
    if ('modules' in stub) placeholder.modules = stub.modules
    return placeholder
}

/**
 * Convert a Chat (or placeholder) to a ChatStub for database.bin encoding.
 *
 * Key presence is preserved even when the value is null/undefined so the
 * stub round-trip distinguishes "user cleared" from "field absent". The
 * server merge layer relies on `in` semantics — see mergeChatStubWithFullChat.
 */
export function chatToStub(chat: Chat | ChatStub): ChatStub {
    if (isChatStub(chat)) return chat
    const stub: ChatStub = {
        id: chat.id ?? '',
        name: chat.name ?? '',
        _stub: true,
    }
    if ('lastDate' in chat) stub.lastDate = chat.lastDate
    if ('folderId' in chat) stub.folderId = chat.folderId
    if ('modules' in chat) stub.modules = chat.modules
    return stub
}

/**
 * Replace all ChatStubs in a character's chats array with placeholder Chats.
 * Call this once after decoding database.bin so runtime code only sees Chat objects.
 *
 * Self-healing for hybrid corruption: if a chat carries the `_stub: true`
 * flag *and* a real message array (legacy v1.4.x disk corruption), strip the
 * flag and keep the Chat as-is. Converting it to a placeholder would call
 * stubToPlaceholder, which resets `message` to `[]` — the corruption would
 * become real data loss the moment the user sees the chat list.
 */
export function convertStubsToPlaceholders(chats: ChatOrStub[]): Chat[] {
    return chats.map(c => {
        if (!c) return c as Chat
        if ((c as any)._stub === true && Array.isArray((c as any).message)) {
            const { _stub: _drop, ...rest } = c as any
            return rest as Chat
        }
        return isChatStub(c) ? stubToPlaceholder(c) : (c as Chat)
    })
}

// Classify a chat slot by shape. Used by the chat-data guard's diagnostic
// dump to surface hybrid corruption (the `_stub: true` + message pattern that
// caused widespread chat data loss in v1.4.x).
export type ChatShape = 'stub' | 'placeholder' | 'hybrid' | 'full' | 'empty' | 'neither'

export function classifyChat(c: any): ChatShape {
    if (!c) return 'empty'
    const isStub = c._stub === true
    const isPh = c._placeholder === true
    const hasMessage = Array.isArray(c.message)
    if (isStub && hasMessage) return 'hybrid'
    if (isStub) return 'stub'
    if (isPh) return 'placeholder'
    if (hasMessage) return 'full'
    return 'neither'
}

// ── Hydration state ──────────────────────────────────────────────────────────

function chatKey(chaId: string, chatId: string): string {
    return `${chaId}/${chatId}`
}

type ChatEvictionOptions = {
    /** Read at every candidate selection, including after persistence awaits. */
    getActiveKey?: () => string | undefined
    /** Evaluated immediately before eviction, after the persistence await. */
    isProtected?: (key: string) => boolean
}

type ChatHydrationCacheOptions = {
    maxChats: number
    flush: () => Promise<void>
    /** Receives a stable key only; cache ownership must never retain Chat objects. */
    onEvict?: (key: string) => unknown | Promise<unknown>
    /** Persist victim metadata before its body is released. */
    prepareEviction?: (key: string) => boolean | void | Promise<boolean | void>
    /** Missing slots are stale cache IDs, not protected residents. */
    isResident?: (key: string) => boolean
}

/**
 * ID-only LRU bookkeeping for hydrated chat bodies.  Actual chat lookup is
 * intentionally delegated to the caller so the LRU cannot keep a message or
 * Chat reference alive after that slot has been stubbed.
 */
export class ChatHydrationCache {
    private readonly order = new Map<string, true>()

    constructor(private readonly options: ChatHydrationCacheOptions) {}

    ids(): string[] {
        return [...this.order.keys()]
    }

    clear(): void {
        this.order.clear()
    }

    private prune(): void {
        if (!this.options.isResident) return
        for (const key of this.order.keys()) if (!this.options.isResident(key)) this.order.delete(key)
    }

    private evictionCandidate(options: ChatEvictionOptions): string | null {
        const activeKey = options.getActiveKey?.()
        for (const key of this.order.keys()) {
            if (key === activeKey || options.isProtected?.(key)) continue
            return key
        }
        return null
    }

    private async flushCandidate(options: ChatEvictionOptions): Promise<string | null> {
        let candidate = this.evictionCandidate(options)
        while (candidate) {
            if (await this.options.prepareEviction?.(candidate) === false) return null
            await this.options.flush()
            // Selection/reordering can pick another victim while persistence
            // is in flight. Mark and flush that new stable ID before release.
            const current = this.evictionCandidate(options)
            if (current === candidate) return candidate
            candidate = current
        }
        return null
    }

    /**
     * Records a completed hydration. A third chat flushes dirty scopes before
     * its oldest safe peer is evicted; a failed flush leaves the LRU unchanged.
     */
    async touch(characterId: string, chatId: string, touchOptions: ChatEvictionOptions = {}): Promise<boolean> {
        const key = chatKey(characterId, chatId)
        this.prune()
        if (this.order.delete(key)) {
            this.order.set(key, true)
            return true
        }
        if (this.order.size < this.options.maxChats) {
            this.order.set(key, true)
            return true
        }

        if (!this.evictionCandidate(touchOptions)) return false
        // Do not adjust ordering before this await: on failure both the slot
        // and the observable LRU order remain exactly as they were.
        const victim = await this.flushCandidate(touchOptions)
        if (!victim) return false
        const evicted = await this.options.onEvict?.(victim)
        if (evicted === false) return false
        this.order.delete(victim)
        this.order.set(key, true)
        return true
    }

    /** Evict every safe resident body except the selected chat. */
    async evictExcept(options: ChatEvictionOptions = {}): Promise<void> {
        this.prune()
        while (true) {
            const victim = await this.flushCandidate(options)
            if (!victim) return
            const evicted = await this.options.onEvict?.(victim)
            if (evicted === false) return
            this.order.delete(victim)
        }
    }
}

function parseChatKey(key: string): { characterId: string; chatId: string } | null {
    const separator = key.lastIndexOf('/')
    if (separator <= 0 || separator === key.length - 1) return null
    return { characterId: key.slice(0, separator), chatId: key.slice(separator + 1) }
}

type RuntimeChat = Chat & {
    messagesLoaded?: boolean
    messagesFullyLoaded?: boolean
    _sqlWindow?: { fullHistoryOperation?: boolean; loading?: boolean }
    isLoadingFullHistory?: boolean
    loadingFullHistory?: boolean
    fullHistoryOperation?: boolean
    _fullHistoryOperation?: boolean
    loadingMessages?: boolean
    isLoading?: boolean
    risuBardWikiReboot?: { status?: string }
}

/** Re-find by stable IDs at eviction time; never retain a character/chat reference in the LRU. */
function findRuntimeChat(key: string): { chats: Chat[]; index: number; chat: RuntimeChat } | null {
    const ids = parseChatKey(key)
    if (!ids) return null
    const character = (getDatabase().characters ?? []).find(value => value?.chaId === ids.characterId)
    const index = character?.chats?.findIndex(value => value?.id === ids.chatId) ?? -1
    const chat = index === -1 ? null : character?.chats[index] as RuntimeChat | undefined
    return chat && character ? { chats: character.chats, index, chat } : null
}

function hasLiveChatWork(key: string): boolean {
    const ids = parseChatKey(key)
    const found = findRuntimeChat(key)
    if (!ids || !found) return true
    const { chat } = found
    return chat._placeholder === true || isHydrationActive(key) || isChatGenerating(ids.chatId) ||
        Boolean(chat.isStreaming || chat.activeStreamingDisplayOptimizationMode ||
            chat.isLoadingFullHistory || chat.loadingFullHistory || chat._sqlWindow?.fullHistoryOperation ||
            chat._sqlWindow?.loading || chat.fullHistoryOperation || chat._fullHistoryOperation ||
            chat.loadingMessages || chat.isLoading || chat.risuBardWikiReboot)
}

function evictRuntimeChat(key: string): boolean {
    const found = findRuntimeChat(key)
    if (!found || hasLiveChatWork(key)) return false
    // Keep every enumerable metadata field. The sole heavy body is `message`;
    // `_sqlWindow` is a non-enumerable runtime cache but is excluded even if a
    // caller made it enumerable. No message or derived-cache reference moves
    // into the replacement slot.
    const metadata = Object.fromEntries(Object.entries(found.chat).filter(([key]) =>
        key !== 'message' && !key.startsWith('_'),
    ))
    found.chats[found.index] = {
        ...metadata,
        message: [],
        _placeholder: true,
        messagesLoaded: false,
        messagesFullyLoaded: false,
    } as Chat
    return true
}

function prepareRuntimeEviction(key: string): boolean {
    const ids = parseChatKey(key)
    if (!ids || hasLiveChatWork(key)) return false
    markSqlChatDirty(ids.characterId, ids.chatId)
    return true
}

const runtimeChatHydrationCache = new ChatHydrationCache({
    maxChats: 2,
    flush: flushSqlDirtyChanges,
    prepareEviction: prepareRuntimeEviction,
    isResident: key => Boolean(findRuntimeChat(key)),
    onEvict: evictRuntimeChat,
})

function getActiveRuntimeChatKey(): string | undefined {
    const database = getDatabase() as typeof getDatabase extends () => infer T ? T & { selectedChatId?: string | null } : never
    const character = database.characters?.[get(selectedCharID)] as character | undefined
    const selected = character?.chats?.[character.chatPage ?? -1]?.id
    return selected && character?.chaId ? chatKey(character.chaId, selected) : undefined
}

/** Public safe eviction entrypoint for saver-mode/resource reclamation. */
export async function evictHydratedChats(): Promise<void> {
    await runtimeChatHydrationCache.evictExcept({ getActiveKey: getActiveRuntimeChatKey, isProtected: hasLiveChatWork })
}

export async function touchHydratedChat(chaId: string, chats: Chat[], index: number): Promise<void> {
    const chatId = chats[index]?.id
    if (!chatId) return
    // Hydration has already applied and settled before this point. An eviction
    // failure must not roll back that successful fetch, so it is deliberately
    // contained here while the cache retains its previous IDs/slot.
    try {
        await runtimeChatHydrationCache.touch(chaId, chatId, {
            getActiveKey: getActiveRuntimeChatKey,
            isProtected: hasLiveChatWork,
        })
    } catch (error) {
        console.warn(`[chatStorage] unable to evict hydrated chat after ${chatKey(chaId, chatId)}`, error)
    }
}

export function resetChatHydrationCacheForTesting(): void {
    runtimeChatHydrationCache.clear()
}

/**
 * Apply the newest bounded SQL message page to one stable chat slot.  The
 * reverse-page hydrator owns window metadata and duplicate suppression; this
 * wrapper is the single convergence point for runtime LRU touches.
 */
export async function hydrateRecentChatPage(
    chats: Chat[],
    index: number,
    chaId: string,
    limit = 40,
): Promise<Chat | null> {
    const initial = chats[index]
    if (!initial?.id) return null
    const hydrated = await ensureChatMessageWindow({ chaId, chats } as character, index, limit)
    if (!hydrated) return null
    await touchHydratedChat(chaId, chats, index)
    return hydrated
}

/** Track in-flight hydration promises to avoid duplicate fetches */
const hydrationPromises = new Map<string, Promise<Chat | null>>()

// ── Server fetch/save ───────────────────────────────────────────────────────

export async function fetchChatFromServer(chaId: string, chatIndex: number, chatId: string): Promise<Chat | null> {
    const storage = forageStorage.realStorage
    return storage.fetchChatContent(chaId, chatIndex, chatId)
}

export async function saveChatToServer(chaId: string, chatIndex: number, chatId: string, chat: Chat): Promise<void> {
    const storage = forageStorage.realStorage
    await storage.saveChatContent(chaId, chatIndex, chatId, chat)
}

// ── Hydration ───────────────────────────────────────────────────────────────

/**
 * Check if a specific chat is currently being hydrated (for dirty tracking suppression).
 */
export function isHydrating(chaId: string, chatId: string): boolean {
    const key = chatKey(chaId, chatId)
    return isHydrationActive(key)
}

/** True when the in-memory message array is not the canonical full history. */
export function isChatHistoryIncomplete(chat: Chat | null | undefined): boolean {
    if (!chat || chat._placeholder) return true
    const runtime = chat as Chat & {
        messagesLoaded?: boolean
        messagesFullyLoaded?: boolean
        _sqlWindow?: { hasOlder?: boolean }
    }
    return runtime.messagesLoaded === false || runtime.messagesFullyLoaded === false || runtime._sqlWindow?.hasOlder === true
}

/**
 * Hydrate a placeholder Chat in-place on the character's chats array.
 * If the slot is already a real Chat (not placeholder), returns it as-is.
 * Returns the hydrated Chat, or null if fetch failed.
 */
export async function ensureChatHydrated(
    chats: Chat[],
    index: number,
    chaId: string,
): Promise<Chat | null> {
    const slot = chats[index]
    if (!slot) return null
    const activeSql = getActiveSqlStorage()
    const needsSqlWindow = activeSql?.backendKind === 'server-sql' && (slot as Chat & { messagesLoaded?: boolean }).messagesLoaded === false
    if (!slot._placeholder && !needsSqlWindow) {
        await touchHydratedChat(chaId, chats, index)
        return slot
    }

    const chatId = slot.id
    if (!chatId) return null
    const key = chatKey(chaId, chatId)

    // Deduplicate concurrent hydration for the same chat
    const existing = hydrationPromises.get(key)
    if (existing) return existing

    const promise = (async () => {
        beginHydration(key)
        try {
            const sqlStorage = activeSql
            if (sqlStorage?.backendKind === 'server-sql') {
                const hydrated = await hydrateRecentChatPage(chats, index, chaId, 40)
                if (!hydrated) return null
                return hydrated
            }
            const full = await fetchChatFromServer(chaId, index, chatId)
            if (!full) {
                console.error(`[chatStorage] hydrate failed: chat not found on server (${key})`)
                return null
            }

            // Clear stale streaming flags: if the app died mid-stream after a
            // save, the server copy can carry isStreaming=true forever.
            // (setDatabase does the same for chats present at boot.)
            full.isStreaming = false
            full.activeStreamingDisplayOptimizationMode = undefined

            const currentIndex = chats.findIndex(chat => chat?.id === chatId)
            if (currentIndex === -1) {
                console.warn(`[chatStorage] hydrate skipped: chat removed before apply (${key})`)
                return null
            }

            const currentSlot = chats[currentIndex]
            if (!currentSlot?._placeholder) {
                return currentSlot
            }

            // Yield one frame so loading overlay dismissal paints before heavy DOM work
            await new Promise<void>(r => requestAnimationFrame(() => r()))

            // Apply to memory — mark JustApplied to suppress the reactive write-back
            beginHydrationApply(key)
            chats[currentIndex] = full

            // Wait one tick so Svelte reactivity settles before allowing dirty tracking
            await tick()
            endHydrationApply(key)

            await touchHydratedChat(chaId, chats, currentIndex)

            return full
        } finally {
            endHydration(key)
            hydrationPromises.delete(key)
        }
    })()

    hydrationPromises.set(key, promise)
    return promise
}

/**
 * Convenience: ensure the current active chat for a character is hydrated.
 */
export async function ensureCurrentChatReady(
    chats: Chat[],
    chatPage: number,
    chaId: string,
): Promise<Chat | null> {
    return ensureChatHydrated(chats, chatPage, chaId)
}
