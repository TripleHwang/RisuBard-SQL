import type { Chat, Database, character } from '../database.svelte'
import {
    deferUntilHydrationApplied,
    isChatHydrationApplying,
    isHydrationActive,
    isHydrationApplying,
} from '../hydrationState'
import { isRootKeyDeferred } from './deferredRootKeys'
import type { ISqlStorage } from './ISqlStorage'
import { DirtyRegistry, type DirtySnapshot } from './dirtyRegistry'
import { buildSqlDirtyCommit } from './sqlDirtyCommit'
import { hasSqlCommitChanges, SqlRevisionConflictError } from './sqlCommit'
import { v4 as uuidv4 } from 'uuid'
import { runtimeMetrics } from '../../performance/runtimeMetrics'

let activeStorage: ISqlStorage | null = null
/**
 * How to reach the database to commit -- never the database itself.
 *
 * Holding the object was the defect: `activateSqlPersistenceRuntime` runs from
 * `activateSqlStorage` at boot, before `setDatabase` wraps that same object as
 * `DBState.db`. A `$state` proxy does not write through to its target, so the
 * held object stopped matching what the user was editing the instant the proxy
 * existed, and every commit after that was built from boot-time values.
 */
let activeDatabaseSource: SqlDatabaseSource | null = null
let compatibilityTimer: ReturnType<typeof setTimeout> | undefined
let compatibilityAuditScheduled = false
let compatibilityRecurrenceTimer: ReturnType<typeof setTimeout> | undefined
let dirtyRetryTimer: ReturnType<typeof setTimeout> | undefined
let metadataRuntimeStarted = false
type CompatibilityBaseline = {
    roots: Map<string, string>
    /**
     * False while `pluginCustomStorage` is deferred: the map is not in memory,
     * so this snapshot knows nothing about its keys. An empty `plugins` map on
     * such a baseline means "unknown", never "the user has none", and any diff
     * against it would read every row as deleted.
     */
    pluginsKnown: boolean
    plugins: Map<string, string>; presets: Map<string, string>
    characters: Map<string, string>; chats: Map<string, { characterId: string; signature: string }>
    messages: Map<string, { order: string[]; values: Map<string, string>; complete: boolean }>
    characterOrder: string[]; presetOrder: string[]; activePreset: number; chatOrders: Map<string, string[]>
}
let compatibilityBaseline: CompatibilityBaseline | null = null

/**
 * Whether a commit is in flight, for the saving indicator.
 *
 * The legacy path drove that indicator from inside `saveDb`, which the SQL path
 * never calls -- so in SQL mode the corner of the screen went quiet and stayed
 * quiet, and there was no way to tell a working save from a silent one. Given
 * this path has already shipped a silent save failure, having no writer at all
 * here is its own defect.
 *
 * Counted rather than set, because an immediate flush can overlap a scheduled
 * one and the first to finish would otherwise report the second as done.
 */
let commitsInFlight = 0
let commitActivityListener: ((active: boolean) => void) | null = null

export function onSqlCommitActivity(listener: ((active: boolean) => void) | null): void {
    commitActivityListener = listener
}

function noteCommitActivity(delta: 1 | -1): void {
    const wasActive = commitsInFlight > 0
    commitsInFlight = Math.max(0, commitsInFlight + delta)
    const isActive = commitsInFlight > 0
    if (isActive !== wasActive) commitActivityListener?.(isActive)
}

const registry = new DirtyRegistry(async () => {
    noteCommitActivity(1)
    try { await commitDirtyScopes() }
    catch (error) { scheduleDirtyRetry(); throw error }
    finally { noteCommitActivity(-1) }
})

/**
 * Where a commit reads the database from.
 *
 * A function is the form production uses, because the object that is correct at
 * boot is not the object the user edits: `setDatabase` wraps it in a `$state`
 * proxy afterwards and the two never reconverge. A bare `Database` is accepted
 * for callers that genuinely own a stable object -- tests that build one live
 * `$state` graph and mutate it directly -- and is resolved as-is.
 */
export type SqlDatabaseSource = Database | (() => Database | null)

function resolveActiveDatabase(): Database | null {
    if (!activeDatabaseSource) return null
    return typeof activeDatabaseSource === 'function' ? activeDatabaseSource() : activeDatabaseSource
}

/**
 * Bind persistence to a database source. Pass a resolver unless you own the
 * object for the whole of its life: a captured object silently stops being the
 * one the user is editing as soon as anything wraps it in `$state`.
 */
export function activateSqlPersistenceRuntime(storage: ISqlStorage, database: SqlDatabaseSource): void {
    activeStorage = storage
    activeDatabaseSource = database
}

export function deactivateSqlPersistenceRuntime(): void {
    activeStorage = null
    activeDatabaseSource = null
}

/**
 * Suppression is scoped to the apply window and defers rather than discards.
 *
 * The previous form asked `isChatHydrationActive`, which is true for the whole
 * of a page fetch, and returned. During a fetch hydration has not written a
 * single byte into the chat, so there was nothing to protect and the only marks
 * in that window belonged to the user: a reply that arrived while an older page
 * was in the air lost its mark, never entered a commit, and was gone after a
 * reload with nothing logged and nothing shown. Scroll-driven loading holds
 * that window open on almost every gesture, which is what turned a latent hole
 * into a reproducible loss.
 *
 * Inside the real apply window the mark is parked, not dropped. Hydration
 * itself never marks anything, so a mark arriving there is still somebody
 * else's edit; the queue drains as soon as the apply finishes.
 */
function whenMarkable(chatId: string, mark: () => void): void {
    deferUntilHydrationApplied(() => isChatHydrationApplying(chatId), mark)
}

export function markSqlMessageDirty(chatId: string, messageId: string, immediate = false): void {
    if (!chatId || !messageId) return
    whenMarkable(chatId, () => {
        registry.markMessage(chatId, messageId)
        scheduleDirtyFlush(immediate)
    })
}

/**
 * True while a message carries an unflushed local change.
 *
 * Residency trimming consults this before releasing a message from memory.
 * `buildSqlDirtyCommit` resolves each dirty id by looking it up in the live
 * `chat.message` array and skips ids it cannot find, so releasing a dirty row
 * turns a pending edit into one that is never written -- silent loss, not a
 * deferral. Unknown is the safe answer here, and an id with no mark is known
 * clean rather than unknown: marks survive until the commit carrying them is
 * acknowledged.
 */
export function isSqlMessageDirty(chatId: string, messageId: string): boolean {
    if (!chatId || !messageId) return false
    return registry.hasMessage(chatId, messageId)
}

export function markSqlMessageDeleted(chatId: string, messageId: string): void {
    if (!chatId || !messageId) return
    whenMarkable(chatId, () => {
        registry.markMessageDeleted(chatId, messageId)
        scheduleDirtyFlush(false)
    })
}

export function markSqlMessageManifestDirty(chatId: string): void {
    if (!chatId) return
    whenMarkable(chatId, () => {
        registry.markMessageManifest(chatId)
        scheduleDirtyFlush(false)
    })
}

export function markSqlChatDirty(characterId: string, chatId: string, manifest = false): void {
    if (!characterId || !chatId) return
    const key = `${characterId}/${chatId}`
    deferUntilHydrationApplied(() => isHydrationApplying(key), () => {
        registry.markChat(characterId, chatId, manifest)
        scheduleDirtyFlush(false)
    })
}

export function markSqlCharacterDirty(characterId: string): void {
    // Left reading the wide predicate on purpose. Nothing registers a bare
    // character id -- `beginHydration` is only ever called with a
    // `characterId/chatId` key -- so this check does not currently fire, and
    // narrowing a condition that is already never true would only make it look
    // as though character hydration had been reasoned about here. It has not.
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

/**
 * Said once, not every five seconds.
 *
 * Normal boot passes through the unresolved window in milliseconds and this
 * never fires. If it keeps firing, persistence is bound to storage that has no
 * live database to read -- the retry loop will keep the user's edits marked, but
 * nothing will ever be written, and that has to be visible rather than inferred
 * from a save indicator that never settles.
 */
let unresolvedDatabaseReported = false

function reportUnresolvedDatabase(): void {
    if (unresolvedDatabaseReported) return
    unresolvedDatabaseReported = true
    console.warn(
        '[SQL dirty commit] SQL storage is active but no live database has been installed yet; ' +
        'pending changes stay marked and will be retried.',
    )
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

/**
 * Rows this flush could not position, kept out of the commit so the rest of it
 * can go, and re-marked afterwards so they are not acknowledged away.
 *
 * Refusing a row is not the same as writing it. It stays dirty, it retries, and
 * if its position never appears it never persists -- but that was already true
 * before, and before, it also took every other chat's writes with it.
 */
type RefusedMessage = { chatId: string; messageId: string }

function reportRefusedMessages(refused: RefusedMessage[], error: unknown): void {
    if (refused.length === 0) return
    console.error(
        `[SQL dirty commit] refused ${refused.length} message(s) with no canonical position; ` +
        `they stay dirty and will be retried: ` +
        refused.map(entry => `${entry.chatId}/${entry.messageId}`).join(', '),
        error,
    )
}

async function commitDirtyScopes(): Promise<void> {
    const storage = activeStorage
    const database = resolveActiveDatabase()
    if (!storage) return
    // Resolved fresh on every flush, never cached across one. A null resolution
    // means storage is bound but the live graph is not installed yet -- the
    // window between `activateSqlStorage` and `setDatabase`. Returning without
    // acknowledging keeps every mark, and the retry is what makes those marks
    // reach a commit: without it they would wait for the user's next edit, and a
    // flush that fired in that window would look like it had succeeded.
    if (!database) {
        reportUnresolvedDatabase()
        scheduleDirtyRetry()
        return
    }
    const snapshot = registry.takeSnapshot()
    const refused: RefusedMessage[] = []
    let lastRefusal: unknown
    const refuse = (chatId: string, messageId: string, error: unknown) => {
        refused.push({ chatId, messageId })
        lastRefusal = error
    }
    // Re-marking is what keeps a refused row dirty. `acknowledge` only clears a
    // scope whose generation matches the one the snapshot recorded, and
    // `markMessage` takes a fresh, higher generation -- so a re-mark placed
    // after the acknowledge survives it, and the row is picked up by the next
    // flush instead of being dropped on the floor.
    const retainRefused = () => {
        for (const entry of refused) registry.markMessage(entry.chatId, entry.messageId)
        reportRefusedMessages(refused, lastRefusal)
    }
    let commit = buildSqlDirtyCommit(database, snapshot, storage.getRevision(), refuse)
    if (!hasSqlCommitChanges(commit)) {
        registry.acknowledge(snapshot)
        retainRefused()
        return
    }
    try {
        await commitWithMetrics(storage, commit)
        registry.acknowledge(snapshot)
        retainRefused()
    } catch (error) {
        if (!(error instanceof SqlRevisionConflictError)) throw error
        // Targeted reads are observability-only: local dirty intent is
        // last-local-wins and must never be overwritten before the retry.
        await rebaseDirtyScopes(storage, snapshot)
        refused.length = 0
        commit = buildSqlDirtyCommit(database, snapshot, storage.getRevision(), refuse)
        if (!hasSqlCommitChanges(commit)) {
            registry.acknowledge(snapshot)
            retainRefused()
            return
        }
        await commitWithMetrics(storage, commit)
        registry.acknowledge(snapshot)
        retainRefused()
    }
}

/** One metric pair per actual row-commit attempt, including the conflict retry. */
async function commitWithMetrics(storage: ISqlStorage, commit: ReturnType<typeof buildSqlDirtyCommit>): Promise<void> {
    const metric = runtimeMetrics.start('dirty-commit')
    try {
        await storage.commit(commit)
    } finally {
        runtimeMetrics.end(metric)
    }
}

/**
 * Conflict recovery intentionally uses entity endpoints only.  A full snapshot
 * can overwrite concurrent rows and is reserved for explicit recovery flows.
 */
/** Targeted-read last-local-wins rebase: a successful present/null read resolves
 * the remote row; our explicit dirty upsert/delete remains authoritative. */
async function rebaseDirtyScopes(storage: ISqlStorage, dirty: DirtySnapshot): Promise<void> {
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

/** Roots carried by their own baseline scope, never by the generic root map. */
const STRUCTURAL_COMPATIBILITY_ROOTS = ['characters', 'pluginCustomStorage', 'botPresets', 'botPresetsId']

function snapshotCompatibility(database: Database): CompatibilityBaseline {
    const roots = new Map<string, string>()
    // A deferred key is not fingerprinted at all: its in-memory value is a
    // placeholder for "unknown", and baselining that would let a later diff
    // read the placeholder as real content.
    for (const key of Object.keys(database)) if (!STRUCTURAL_COMPATIBILITY_ROOTS.includes(key) && !isRootKeyDeferred(key)) roots.set(key, fingerprint((database as any)[key]))
    // A deferred plugin storage map is fingerprinted as nothing at all and
    // flagged as unknown, so `auditSqlCompatibilityDatabase` skips the diff
    // instead of reading the absence as hundreds of deleted rows.
    const pluginsKnown = !isRootKeyDeferred('pluginCustomStorage')
    const plugins = pluginsKnown
        ? new Map(Object.entries(database.pluginCustomStorage ?? {}).map(([key, value]) => [key, fingerprint(value)]))
        : new Map<string, string>()
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
    return { roots, pluginsKnown, plugins, presets, characters, chats, messages, characterOrder: (database.characters ?? []).map(c => c?.chaId).filter(Boolean), presetOrder: (database.botPresets ?? []).map(p => p.id).filter(Boolean), activePreset: Number(database.botPresetsId) || 0, chatOrders }
}

function changedKeys(before: Map<string, string>, after: Map<string, string>): Set<string> {
    return new Set([...before.keys(), ...after.keys()].filter(key => before.get(key) !== after.get(key)))
}

/**
 * Root-key diff. A deferred key is absent from the in-memory database because
 * it has not been loaded, not because it changed, so it must never enter this
 * set: doing so marks it dirty, and a dirty absent root key becomes a DELETE.
 */
function changedRootKeys(before: Map<string, string>, after: Map<string, string>): Set<string> {
    const changed = changedKeys(before, after)
    for (const key of changed) if (isRootKeyDeferred(key)) changed.delete(key)
    return changed
}

/**
 * Fold a just-loaded deferred root key into the standing baseline.
 *
 * `auditSqlCompatibilityDatabase` installs `next` as the new baseline before it
 * decides what to diff, and it deliberately skips a scope whose two snapshots
 * disagree about whether the value was known. On the unknown -> known
 * transition those two facts combine badly: the newly-loaded value is adopted
 * as the baseline without ever being diffed, so any write made between the load
 * and the next audit is absorbed and never persisted. Silent write loss is the
 * same failure this guard exists to prevent, only moved from deleted rows to
 * changes that never leave memory.
 *
 * The caller runs this in the same synchronous step that installs the value, so
 * what is fingerprinted here is what storage returned, not a mutated copy.
 * Every other scope is left alone: their pending changes must still be audited.
 */
export function rebaselineHydratedRootKey(database: Database, key: string): void {
    if (!compatibilityBaseline) return
    const record = database as unknown as Record<string, unknown>
    if (key === 'pluginCustomStorage') {
        compatibilityBaseline.pluginsKnown = true
        compatibilityBaseline.plugins = new Map(
            Object.entries(database.pluginCustomStorage ?? {}).map(([entry, value]) => [entry, fingerprint(value)]),
        )
        return
    }
    if (STRUCTURAL_COMPATIBILITY_ROOTS.includes(key)) return
    compatibilityBaseline.roots.set(key, fingerprint(record[key]))
}

/**
 * A message id missing from a chat's array means "deleted" only when that array
 * is the whole history. Under SQL windowing it is a slice: hydration makes the
 * newest forty resident, and eviction (chatStorage.ts:300) drops the array
 * entirely while setting messagesFullyLoaded false. Without this guard the idle
 * audit reads an evicted chat as one whose every message the user just deleted,
 * and issues a delete for each -- partial knowledge turned into a definite
 * negative, against rows that are still on disk.
 */
function deleteMissing(
    chatId: string,
    prior: { order: string[] },
    current: { values: Map<string, string>; complete: boolean },
): void {
    if (!current.complete) return
    for (const id of prior.order) if (!current.values.has(id)) markSqlMessageDeleted(chatId, id)
}

/**
 * True when two partial snapshots of one chat's message order cannot be
 * reconciled without knowing every message's persisted position.
 *
 * Two things make a partial diff unreconcilable:
 *
 *   - the ids both snapshots know changed their order relative to each other;
 *   - a new id appeared *between* two ids the baseline already knew, so the
 *     audit cannot tell where in the persisted history it belongs.
 *
 * Everything else is safe, and one case in particular has to be: new ids
 * arriving at the *front*. That is exactly what `loadOlderChatMessages` does --
 * it splices an older page onto the start of the resident slice -- and the
 * previous rule required the shared ids to still be the first N of the current
 * order, which is true of an append and false of every prepend there has ever
 * been. So the first time a reader scrolled back, this chat was declared
 * unreconcilable, its baseline was pinned to the pre-scroll snapshot, and it
 * stayed pinned: the same comparison failed identically on every later audit.
 * From that moment the audit could no longer see a message arrive in that chat
 * at all, which is the second chance a dropped dirty mark depends on.
 *
 * The middle-insertion case this exists for still trips it: an id spliced
 * between two known ones lands inside the shared span and is caught below.
 */
function hasUnreconcilablePartialOrder(
    prior: { order: string[]; values: Map<string, string> },
    current: { order: string[]; values: Map<string, string> },
    currentPrior: string[],
): boolean {
    const survivingPrior = prior.order.filter(id => current.values.has(id))
    if (survivingPrior.join('\u0000') !== currentPrior.join('\u0000')) return true
    const first = current.order.findIndex(id => prior.values.has(id))
    // No shared id at all: there is no known span for anything to be inserted
    // into, so nothing here can be misplaced relative to the baseline.
    if (first < 0) return false
    let last = first
    for (let index = current.order.length - 1; index > first; index -= 1) {
        if (prior.values.has(current.order[index])) { last = index; break }
    }
    for (let index = first; index <= last; index += 1) {
        if (!prior.values.has(current.order[index])) return true
    }
    return false
}

/** Idle compatibility audit: baseline first, then only explicitly changed scopes. */
export function auditSqlCompatibilityDatabase(database: Database): void {
    const next = snapshotCompatibility(database)
    const previous = compatibilityBaseline
    compatibilityBaseline = next
    if (!previous) return
    for (const key of changedRootKeys(previous.roots, next.roots)) markSqlRootDirty(key)
    // Only diff plugin storage when BOTH snapshots actually knew its contents.
    // A load (unknown -> known) is not an edit, and a deferral (known ->
    // unknown) is not a deletion; treating either as a change would mark every
    // row dirty, which for the "unknown" side means marking them for deletion.
    if (previous.pluginsKnown && next.pluginsKnown) {
        for (const key of changedKeys(previous.plugins, next.plugins)) markSqlPluginStorageDirty(key)
    }
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
        const prior = previous.messages.get(chatId)
        if (!prior) {
            for (const id of current.order) markSqlMessageDirty(chatId, id)
            if (current.complete) markSqlMessageManifestDirty(chatId)
            continue
        }
        const currentPrior = current.order.filter(id => prior.values.has(id))
        const unsafePartialOrder = !prior.complete && !current.complete &&
            hasUnreconcilablePartialOrder(prior, current, currentPrior)
        if (unsafePartialOrder) {
            console.warn(`[SQL compatibility audit] deferred unsafe middle message insertion/reorder in partial chat ${chatId}; hydrate it before retrying`)
            // Keep this chat's old baseline so a later full hydration can safely
            // reconcile the same mutation. Independent row edits below remain dirty.
            next.messages.set(chatId, prior)
            for (const id of currentPrior) if (prior.values.get(id) !== current.values.get(id)) markSqlMessageDirty(chatId, id)
            deleteMissing(chatId, prior, current)
            continue
        }
        for (const id of current.order) if (prior.values.get(id) !== current.values.get(id)) markSqlMessageDirty(chatId, id)
        deleteMissing(chatId, prior, current)
        if (current.complete && prior.order.join('\u0000') !== current.order.join('\u0000')) {
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
    commitsInFlight = 0
    commitActivityListener = null
    if (compatibilityTimer !== undefined) clearTimeout(compatibilityTimer)
    if (compatibilityRecurrenceTimer !== undefined) clearTimeout(compatibilityRecurrenceTimer)
    if (dirtyRetryTimer !== undefined) clearTimeout(dirtyRetryTimer)
    compatibilityTimer = undefined
    compatibilityRecurrenceTimer = undefined
    dirtyRetryTimer = undefined
    compatibilityAuditScheduled = false
    metadataRuntimeStarted = false
    compatibilityBaseline = null
    unresolvedDatabaseReported = false
    deactivateSqlPersistenceRuntime()
}
