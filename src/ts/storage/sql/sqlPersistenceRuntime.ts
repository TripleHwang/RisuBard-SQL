import type { Chat, Database, character } from '../database.svelte'
import { isChatHydrationActive, isHydrationActive } from '../hydrationState'
import type { ISqlStorage } from './ISqlStorage'
import { DirtyRegistry, type DirtySnapshot } from './dirtyRegistry'
import { buildSqlDirtyCommit } from './sqlDirtyCommit'
import { hasSqlCommitChanges, SqlRevisionConflictError } from './sqlCommit'
import { v4 as uuidv4 } from 'uuid'

let activeStorage: ISqlStorage | null = null
let activeDatabase: Database | null = null
let compatibilityTimer: ReturnType<typeof setTimeout> | undefined
let compatibilityAuditScheduled = false
let compatibilityRecurrenceTimer: ReturnType<typeof setTimeout> | undefined
let dirtyRetryTimer: ReturnType<typeof setTimeout> | undefined
let metadataRuntimeStarted = false
type CompatibilityBaseline = {
    roots: Map<string, string>; plugins: Map<string, string>; presets: Map<string, string>
    characters: Map<string, string>; chats: Map<string, { characterId: string; signature: string }>
    messages: Map<string, { order: string[]; values: Map<string, string>; complete: boolean }>
    characterOrder: string[]; presetOrder: string[]; activePreset: number; chatOrders: Map<string, string[]>
}
let compatibilityBaseline: CompatibilityBaseline | null = null

const registry = new DirtyRegistry(async () => {
    try { await commitDirtyScopes() }
    catch (error) { scheduleDirtyRetry(); throw error }
})

/** The active database is deliberately a live reference: normal typing must not clone it. */
export function activateSqlPersistenceRuntime(storage: ISqlStorage, database: Database): void {
    activeStorage = storage
    activeDatabase = database
}

export function deactivateSqlPersistenceRuntime(): void {
    activeStorage = null
    activeDatabase = null
}

export function markSqlMessageDirty(chatId: string, messageId: string, immediate = false): void {
    if (!chatId || !messageId || isChatHydrationActive(chatId)) return
    registry.markMessage(chatId, messageId)
    scheduleDirtyFlush(immediate)
}

export function markSqlMessageDeleted(chatId: string, messageId: string): void {
    if (!chatId || !messageId || isChatHydrationActive(chatId)) return
    registry.markMessageDeleted(chatId, messageId)
    scheduleDirtyFlush(false)
}

export function markSqlMessageManifestDirty(chatId: string): void {
    if (!chatId || isChatHydrationActive(chatId)) return
    registry.markMessageManifest(chatId)
    scheduleDirtyFlush(false)
}

export function markSqlChatDirty(characterId: string, chatId: string, manifest = false): void {
    if (!characterId || !chatId || isHydrationActive(`${characterId}/${chatId}`)) return
    registry.markChat(characterId, chatId, manifest)
    scheduleDirtyFlush(false)
}

export function markSqlCharacterDirty(characterId: string): void {
    if (!characterId || isHydrationActive(characterId)) return
    registry.markCharacter(characterId)
    scheduleDirtyFlush(false)
}

export function markSqlRootDirty(key: string): void {
    if (!key) return
    registry.markRoot(key)
    scheduleDirtyFlush(false)
}

export function markSqlPresetDirty(id: string): void {
    if (!id) return
    registry.markPreset(id)
    scheduleDirtyFlush(false)
}

export function markSqlPluginStorageDirty(key: string): void {
    if (!key) return
    registry.markPluginStorage(key)
    scheduleDirtyFlush(false)
}

function scheduleDirtyFlush(immediate: boolean): void {
    if (immediate) void registry.flushNow().catch(() => undefined)
    else registry.schedule(350)
}

function scheduleDirtyRetry(): void {
    if (dirtyRetryTimer !== undefined) return
    dirtyRetryTimer = setTimeout(() => {
        dirtyRetryTimer = undefined
        void flushSqlDirtyChanges().catch(() => undefined)
    }, 5_000)
}

/** Flush only scopes explicitly marked at mutation boundaries. Rejections retain the registry. */
export async function flushSqlDirtyChanges(): Promise<void> {
    await registry.flushNow()
}

async function commitDirtyScopes(): Promise<void> {
    const storage = activeStorage
    const database = activeDatabase
    if (!storage || !database) return
    const snapshot = registry.takeSnapshot()
    let commit = buildSqlDirtyCommit(database, snapshot, storage.getRevision())
    if (!hasSqlCommitChanges(commit)) {
        registry.acknowledge(snapshot)
        return
    }
    try {
        await storage.commit(commit)
        registry.acknowledge(snapshot)
    } catch (error) {
        if (!(error instanceof SqlRevisionConflictError)) throw error
        // Targeted reads are observability-only: local dirty intent is
        // last-local-wins and must never be overwritten before the retry.
        await observeDirtyEntities(storage, snapshot)
        commit = buildSqlDirtyCommit(database, snapshot, storage.getRevision())
        if (!hasSqlCommitChanges(commit)) {
            registry.acknowledge(snapshot)
            return
        }
        await storage.commit(commit)
        registry.acknowledge(snapshot)
    }
}

/**
 * Conflict recovery intentionally uses entity endpoints only.  A full snapshot
 * can overwrite concurrent rows and is reserved for explicit recovery flows.
 */
async function observeDirtyEntities(storage: ISqlStorage, dirty: DirtySnapshot): Promise<void> {
    for (const key of dirty.rootKeys) await storage.loadSettingKey(key)
    for (const key of dirty.pluginStorageKeys) await storage.loadPluginCustomStorageKey(key)
    for (const id of dirty.presetIds) await storage.loadBotPreset(id)
    for (const characterId of dirty.characterIds) {
        await storage.loadCharacter(characterId)
    }
    for (const { characterId, chatId } of dirty.chats) {
        await storage.loadChat(chatId, { messageLimit: 100 })
    }
    const messageChatIds = new Set([
        ...dirty.messages.map(({ chatId }) => chatId),
        ...dirty.messageManifestChatIds,
        ...dirty.messageDeletes.map(({ chatId }) => chatId),
    ])
    for (const chatId of messageChatIds) {
        await storage.loadChat(chatId, { messageLimit: 1 })
        await storage.loadChatMessages(chatId)
    }
}

/** Plugins may mutate raw objects. Scan once when idle, never on each keystroke. */
export function scheduleSqlCompatibilityAudit(run?: () => Promise<void> | void): void {
    if (compatibilityAuditScheduled) return
    compatibilityAuditScheduled = true
    const execute = () => {
        compatibilityTimer = undefined
        compatibilityAuditScheduled = false
        void Promise.resolve(run?.()).catch(error => console.error('SQL compatibility audit failed', error))
    }
    const idle = globalThis.requestIdleCallback
    if (idle) {
        idle(() => execute(), { timeout: 5_000 })
        // `requestIdleCallback` has its own timeout; keep the fallback only for
        // browsers without it, so audit remains a single coalesced callback.
    } else {
        compatibilityTimer = setTimeout(execute, 1_000)
    }
}

/** Own the recurring compatibility scan so repeated metadata startup cannot multiply it. */
export function startSqlCompatibilityAuditLoop(run: () => Promise<void> | void): void {
    if (compatibilityRecurrenceTimer !== undefined) return
    const repeat = () => {
        scheduleSqlCompatibilityAudit(run)
        compatibilityRecurrenceTimer = setTimeout(repeat, 5_000)
    }
    repeat()
}

function fingerprint(value: unknown): string {
    try { return JSON.stringify(value) ?? 'undefined' }
    catch { return String(value) }
}

function snapshotCompatibility(database: Database): CompatibilityBaseline {
    const roots = new Map<string, string>()
    for (const key of Object.keys(database)) if (!['characters', 'pluginCustomStorage', 'botPresets', 'botPresetsId'].includes(key)) roots.set(key, fingerprint((database as any)[key]))
    const plugins = new Map(Object.entries(database.pluginCustomStorage ?? {}).map(([key, value]) => [key, fingerprint(value)]))
    for (const preset of database.botPresets ?? []) preset.id ||= uuidv4()
    const presets = new Map((database.botPresets ?? []).filter(preset => preset.id).map(preset => [preset.id!, fingerprint(preset)]))
    const characters = new Map<string, string>(); const chats = new Map<string, { characterId: string; signature: string }>(); const chatOrders = new Map<string, string[]>(); const messages = new Map<string, { order: string[]; values: Map<string, string>; complete: boolean }>()
    for (const character of database.characters ?? []) {
        if (!character) continue
        character.chaId ||= uuidv4()
        characters.set(character.chaId, fingerprint({ ...character, chats: undefined }))
        for (const chat of character.chats ?? []) if (chat) chat.id ||= uuidv4()
        const ids = (character.chats ?? []).map(chat => chat?.id).filter((id): id is string => Boolean(id)); chatOrders.set(character.chaId, ids)
        for (const chat of character.chats ?? []) { if (!chat) continue; {
            chats.set(chat.id, { characterId: character.chaId, signature: fingerprint({ ...chat, message: undefined }) })
            const rows = chat.message ?? []; for (const message of rows) message.chatId ||= uuidv4()
            messages.set(chat.id, { order: rows.map(message => message.chatId!), values: new Map(rows.map(message => [message.chatId!, fingerprint(message)])), complete: (chat as Chat & { messagesFullyLoaded?: boolean }).messagesFullyLoaded !== false })
        } }
    }
    return { roots, plugins, presets, characters, chats, messages, characterOrder: (database.characters ?? []).map(c => c?.chaId).filter(Boolean), presetOrder: (database.botPresets ?? []).map(p => p.id).filter(Boolean), activePreset: Number(database.botPresetsId) || 0, chatOrders }
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): Set<string> {
    return new Set([...before.keys(), ...after.keys()].filter(key => before.get(key) !== after.get(key)))
}

/** Idle compatibility audit: baseline first, then only explicitly changed scopes. */
export function auditSqlCompatibilityDatabase(database: Database): void {
    const next = snapshotCompatibility(database)
    const previous = compatibilityBaseline
    compatibilityBaseline = next
    if (!previous) return
    for (const key of changedKeys(previous.roots, next.roots)) markSqlRootDirty(key)
    for (const key of changedKeys(previous.plugins, next.plugins)) markSqlPluginStorageDirty(key)
    for (const id of changedKeys(previous.presets, next.presets)) markSqlPresetDirty(id)
    if (previous.presetOrder.join('\u0000') !== next.presetOrder.join('\u0000')) markSqlRootDirty('botPresets')
    if (previous.activePreset !== next.activePreset) markSqlRootDirty('botPresetsId')
    for (const id of changedKeys(previous.characters, next.characters)) markSqlCharacterDirty(id)
    const characterOrderChanged = previous.characterOrder.join('\u0000') !== next.characterOrder.join('\u0000')
    const changedChats = changedKeys(new Map([...previous.chats].map(([id, value]) => [id, `${value.characterId}\u0000${value.signature}`])), new Map([...next.chats].map(([id, value]) => [id, `${value.characterId}\u0000${value.signature}`])))
    for (const chatId of changedChats) {
        const info = next.chats.get(chatId) ?? previous.chats.get(chatId)
        if (info) markSqlChatDirty(info.characterId, chatId, true)
    }
    if (characterOrderChanged) for (const id of next.characterOrder) markSqlCharacterDirty(id)
    for (const [characterId, order] of next.chatOrders) if (previous.chatOrders.get(characterId)?.join('\u0000') !== order.join('\u0000')) {
        for (const chatId of order) markSqlChatDirty(characterId, chatId, true)
    }
    for (const [chatId, current] of next.messages) {
        const prior = previous.messages.get(chatId); if (!prior) continue
        const survivingPrior = prior.order.filter(id => current.values.has(id))
        const currentPrior = current.order.filter(id => prior.values.has(id))
        const unsafePartialOrder = !prior.complete && (
            survivingPrior.join('\u0000') !== currentPrior.join('\u0000') ||
            current.order.slice(0, currentPrior.length).join('\u0000') !== currentPrior.join('\u0000')
        )
        if (unsafePartialOrder) {
            console.warn(`[SQL compatibility audit] deferred unsafe middle message insertion/reorder in partial chat ${chatId}; hydrate it before retrying`)
            continue
        }
        for (const id of current.order) if (prior.values.get(id) !== current.values.get(id)) markSqlMessageDirty(chatId, id)
        for (const id of prior.order) if (!current.values.has(id)) markSqlMessageDeleted(chatId, id)
        if (prior.complete && current.complete && prior.order.join('\u0000') !== current.order.join('\u0000')) {
            for (const id of current.order) markSqlMessageDirty(chatId, id)
            markSqlMessageManifestDirty(chatId)
        }
    }
}

export function initializeSqlCompatibilityBaseline(database: Database): void {
    compatibilityBaseline = snapshotCompatibility(database)
}

/** Metadata-first startup deliberately avoids saveDb and its reactive encoder path. */
export function startSqlMetadataPersistence(
    eventTarget: Pick<Window, 'addEventListener'> = window,
    keepalive: () => void = () => {},
): void {
    if (metadataRuntimeStarted) return
    metadataRuntimeStarted = true
    const flush = () => { void flushSqlDirtyChanges().catch(() => undefined); keepalive() }
    eventTarget.addEventListener('pagehide', flush)
    eventTarget.addEventListener('visibilitychange', () => {
        if (typeof document === 'undefined' || document.visibilityState === 'hidden') flush()
    })
}

export function resetSqlPersistenceRuntimeForTesting(): void {
    if (compatibilityTimer !== undefined) clearTimeout(compatibilityTimer)
    if (compatibilityRecurrenceTimer !== undefined) clearTimeout(compatibilityRecurrenceTimer)
    if (dirtyRetryTimer !== undefined) clearTimeout(dirtyRetryTimer)
    compatibilityTimer = undefined
    compatibilityRecurrenceTimer = undefined
    dirtyRetryTimer = undefined
    compatibilityAuditScheduled = false
    metadataRuntimeStarted = false
    compatibilityBaseline = null
    deactivateSqlPersistenceRuntime()
}
