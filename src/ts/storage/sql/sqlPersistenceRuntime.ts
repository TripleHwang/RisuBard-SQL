import type { Chat, Database, character } from '../database.svelte'
import { isChatHydrationActive, isHydrationActive } from '../hydrationState'
import type { ISqlStorage } from './ISqlStorage'
import { DirtyRegistry, type DirtySnapshot } from './dirtyRegistry'
import { buildSqlDirtyCommit } from './sqlDirtyCommit'
import { hasSqlCommitChanges, SqlRevisionConflictError } from './sqlCommit'

let activeStorage: ISqlStorage | null = null
let activeDatabase: Database | null = null
let compatibilityTimer: ReturnType<typeof setTimeout> | undefined
let compatibilityAuditScheduled = false
let metadataRuntimeStarted = false

const registry = new DirtyRegistry(async () => {
    await commitDirtyScopes()
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
    compatibilityTimer = undefined
    compatibilityAuditScheduled = false
    metadataRuntimeStarted = false
    deactivateSqlPersistenceRuntime()
}
