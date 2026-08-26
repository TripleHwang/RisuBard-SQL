import type { Chat, Database, character } from '../database.svelte'
import { isHydrationActive } from '../hydrationState'
import type { ISqlStorage } from './ISqlStorage'
import { DirtyRegistry, type DirtySnapshot } from './dirtyRegistry'
import { buildSqlDirtyCommit } from './sqlDirtyCommit'
import { hasSqlCommitChanges, SqlRevisionConflictError } from './sqlCommit'

let activeStorage: ISqlStorage | null = null
let activeDatabase: Database | null = null
let compatibilityTimer: ReturnType<typeof setTimeout> | undefined
let compatibilityAuditScheduled = false

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
    if (!chatId || !messageId || isHydrationActive(chatId)) return
    registry.markMessage(chatId, messageId)
    scheduleDirtyFlush(immediate)
}

export function markSqlMessageDeleted(chatId: string, messageId: string): void {
    if (!chatId || !messageId || isHydrationActive(chatId)) return
    registry.markMessageDeleted(chatId, messageId)
    scheduleDirtyFlush(false)
}

export function markSqlMessageManifestDirty(chatId: string): void {
    if (!chatId || isHydrationActive(chatId)) return
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
        await refreshDirtyEntities(storage, database, snapshot)
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
async function refreshDirtyEntities(storage: ISqlStorage, database: Database, dirty: DirtySnapshot): Promise<void> {
    for (const characterId of dirty.characterIds) {
        const remote = await storage.loadCharacter(characterId)
        if (remote) replaceCharacter(database, characterId, remote)
    }
    for (const { characterId, chatId } of dirty.chats) {
        const remote = await storage.loadChat(chatId, { messageLimit: 100 })
        if (remote) replaceChat(database, characterId, chatId, remote)
    }
    const messageChatIds = new Set([
        ...dirty.messages.map(({ chatId }) => chatId),
        ...dirty.messageManifestChatIds,
        ...dirty.messageDeletes.map(({ chatId }) => chatId),
    ])
    for (const chatId of messageChatIds) {
        const local = findChat(database, chatId)
        if (!local) continue
        const remote = await storage.loadChatMessages(chatId)
        // Preserve locally appended rows; otherwise a conflict refresh could drop them.
        const localById = new Map((local.message ?? []).map(message => [message.chatId, message]))
        local.message = remote.map(message => localById.get(message.chatId) ?? message)
    }
}

function replaceCharacter(database: Database, id: string, value: character): void {
    const index = database.characters.findIndex(item => item?.chaId === id)
    if (index >= 0) database.characters[index] = value
}

function replaceChat(database: Database, characterId: string, chatId: string, value: Chat): void {
    const character = database.characters.find(item => item?.chaId === characterId)
    const index = character?.chats?.findIndex(item => item?.id === chatId) ?? -1
    if (character && index >= 0) character.chats[index] = value
}

function findChat(database: Database, chatId: string): Chat | null {
    for (const character of database.characters ?? []) {
        const chat = character?.chats?.find(item => item?.id === chatId)
        if (chat) return chat
    }
    return null
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

export function resetSqlPersistenceRuntimeForTesting(): void {
    if (compatibilityTimer !== undefined) clearTimeout(compatibilityTimer)
    compatibilityTimer = undefined
    compatibilityAuditScheduled = false
    deactivateSqlPersistenceRuntime()
}
