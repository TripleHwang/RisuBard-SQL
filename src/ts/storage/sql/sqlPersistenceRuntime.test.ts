import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ISqlStorage } from './ISqlStorage'
import { beginHydration, endHydration } from '../hydrationState'
import { SqlRevisionConflictError } from './sqlCommit'
import {
    activateSqlPersistenceRuntime,
    auditSqlCompatibilityDatabase,
    flushSqlDirtyChanges,
    initializeSqlCompatibilityBaseline,
    markSqlMessageDirty,
    startSqlMetadataPersistence,
    startSqlCompatibilityAuditLoop,
    resetSqlPersistenceRuntimeForTesting,
    scheduleSqlCompatibilityAudit,
} from './sqlPersistenceRuntime'

function fixtureDatabaseWithMessages(count: number) {
    return {
        characters: [{ chaId: 'character-a', chats: [{ id: 'chat-a', message: Array.from({ length: count }, (_, position) => ({
            chatId: `m-${position}`, role: 'char', data: `message-${position}`,
        })) }] }],
        botPresets: [], pluginCustomStorage: {},
    } as any
}

function fakeStorageAtRevision(revision: number): ISqlStorage {
    return {
        getRevision: vi.fn(() => revision),
        commit: vi.fn(async () => ({ revision: revision + 1 })),
    } as unknown as ISqlStorage
}

afterEach(() => resetSqlPersistenceRuntimeForTesting())

describe('SQL persistence runtime', () => {
    it('commits a marked message without a full database clone', async () => {
        const storage = fakeStorageAtRevision(3)
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(20_000))

        markSqlMessageDirty('chat-a', 'm-19999')
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            baseRevision: 3,
            messages: [expect.objectContaining({ id: 'm-19999', chatId: 'chat-a', position: 19_999 })],
        }))
    })

    it('schedules, rather than immediately runs, compatibility audit', () => {
        const audit = vi.fn()
        scheduleSqlCompatibilityAudit(audit)
        expect(audit).not.toHaveBeenCalled()
    })

    it('retains dirty scopes when an unload flush rejects', async () => {
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockRejectedValueOnce(new Error('offline'))
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(1))
        markSqlMessageDirty('chat-a', 'm-0')

        await expect(flushSqlDirtyChanges()).rejects.toThrow('offline')
        ;(storage.commit as any).mockResolvedValueOnce({ revision: 4 })
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledTimes(2)
    })

    it('retries a rejected dirty flush once after the bounded backoff', async () => {
        vi.useFakeTimers()
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ revision: 4 })
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(1))
        markSqlMessageDirty('chat-a', 'm-0')
        await expect(flushSqlDirtyChanges()).rejects.toThrow('offline')
        await vi.advanceTimersByTimeAsync(5_000)
        expect(storage.commit).toHaveBeenCalledTimes(2)
    })

    it('installs one metadata lifecycle runtime without doing a legacy save', () => {
        const add = vi.fn()
        const keepalive = vi.fn()
        startSqlMetadataPersistence({ addEventListener: add } as any, keepalive)
        startSqlMetadataPersistence({ addEventListener: add } as any, keepalive)
        expect(add).toHaveBeenCalledTimes(2)
        expect(keepalive).not.toHaveBeenCalled()
    })

    it('does not mark a message while its character/chat hydration is active', async () => {
        const storage = fakeStorageAtRevision(3)
        activateSqlPersistenceRuntime(storage, fixtureDatabaseWithMessages(1))
        beginHydration('character-a/chat-a')
        markSqlMessageDirty('chat-a', 'm-0', true)
        await Promise.resolve()
        endHydration('character-a/chat-a')
        expect(storage.commit).not.toHaveBeenCalled()
    })

    it('retries a conflict without replacing the dirty local append', async () => {
        const database = fixtureDatabaseWithMessages(1)
        database.characters[0].chats[0].message.push({ chatId: 'm-local', role: 'char', data: 'local' })
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockRejectedValueOnce(new SqlRevisionConflictError(4)).mockResolvedValueOnce({ revision: 5 })
        ;(storage.loadChatMessages as any) = vi.fn(async () => [{ chatId: 'm-0', role: 'char', data: 'remote' }])
        ;(storage.loadChat as any) = vi.fn(async () => null)
        activateSqlPersistenceRuntime(storage, database)
        markSqlMessageDirty('chat-a', 'm-local')

        await flushSqlDirtyChanges()

        expect(database.characters[0].chats[0].message.at(-1)).toMatchObject({ chatId: 'm-local', data: 'local' })
        expect((storage.commit as any).mock.calls[1][0].messages).toEqual([expect.objectContaining({ id: 'm-local' })])
    })

    it('treats a missing remote entity as resolved while retaining a local delete', async () => {
        const database = fixtureDatabaseWithMessages(0); database.characters = []
        const storage = fakeStorageAtRevision(3)
        ;(storage.commit as any).mockRejectedValueOnce(new SqlRevisionConflictError(4)).mockResolvedValueOnce({ revision: 5 })
        ;(storage.loadCharacter as any) = vi.fn(async () => null)
        activateSqlPersistenceRuntime(storage, database)
        const { markSqlCharacterDirty } = await import('./sqlPersistenceRuntime')
        markSqlCharacterDirty('character-a')
        await flushSqlDirtyChanges()
        expect((storage.commit as any).mock.calls[1][0].characterDeletes).toEqual(['character-a'])
    })

    it('uses the first compatibility audit as a baseline and writes only a changed root', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabaseWithMessages(0)
        database.theme = 'dark'
        activateSqlPersistenceRuntime(storage, database)
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()
        database.theme = 'light'
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()
        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({ root: { upserts: [{ key: 'theme', value: 'light' }], deletes: [] } }))
    })

    it('detects an edit made before the first idle compatibility audit', async () => {
        const storage = fakeStorageAtRevision(3); const database = fixtureDatabaseWithMessages(0)
        database.theme = 'dark'; activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)
        database.theme = 'light'; auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()
        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({ root: { upserts: [{ key: 'theme', value: 'light' }], deletes: [] } }))
    })

    it('owns one cancelable compatibility recurrence across repeated startup', async () => {
        vi.useFakeTimers()
        const audit = vi.fn()
        startSqlCompatibilityAuditLoop(audit)
        startSqlCompatibilityAuditLoop(audit)
        await vi.advanceTimersByTimeAsync(1_000)
        expect(audit).toHaveBeenCalledTimes(1)
        resetSqlPersistenceRuntimeForTesting()
        await vi.advanceTimersByTimeAsync(10_000)
        expect(audit).toHaveBeenCalledTimes(1)
    })

    it('detects an idle-only raw plugin message edit and preserves its row id', async () => {
        const storage = fakeStorageAtRevision(3); const database = fixtureDatabaseWithMessages(1)
        activateSqlPersistenceRuntime(storage, database); initializeSqlCompatibilityBaseline(database)
        database.characters[0].chats[0].message[0].data = 'plugin edit'
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({ messages: [expect.objectContaining({ id: 'm-0', data: expect.objectContaining({ data: 'plugin edit' }) })] }))
    })

    it('does not write an unsafe middle insertion in an incomplete resident history', async () => {
        const storage = fakeStorageAtRevision(3); const database = fixtureDatabaseWithMessages(2)
        database.characters[0].chats[0].messagesFullyLoaded = false
        activateSqlPersistenceRuntime(storage, database); initializeSqlCompatibilityBaseline(database)
        database.characters[0].chats[0].message.splice(1, 0, { chatId: 'm-middle', role: 'char', data: 'unsafe' })
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()
        database.characters[0].chats[0].messagesFullyLoaded = true
        auditSqlCompatibilityDatabase(database); await flushSqlDirtyChanges()
        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({ messageManifests: [{ chatId: 'chat-a', ids: ['m-0', 'm-middle', 'm-1'] }] }))
    })
})

describe('an unloaded chat is not a chat whose messages were deleted', () => {
    // SQL windowing makes chat.message a slice, and eviction (chatStorage.ts:300)
    // drops it entirely while setting messagesFullyLoaded false. The idle audit
    // used to read that as the user having deleted every message in the chat and
    // issued a delete for each -- against rows still on disk.
    const messageDeletesOf = (storage: ISqlStorage): string[] =>
        (storage.commit as any).mock.calls.flatMap(([commit]: [any]) =>
            (commit.messageDeletes ?? []).flatMap((entry: any) => entry.ids as string[]))

    it('issues no deletes when a windowed chat is evicted', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabaseWithMessages(40)
        const chat = database.characters[0].chats[0]
        chat.messagesFullyLoaded = false
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        // Eviction: the array is emptied and the chat is marked not fully loaded.
        chat.message = []
        chat.messagesLoaded = false
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(messageDeletesOf(storage)).toEqual([])
    })

    it('still deletes a message removed from a fully loaded chat', async () => {
        const storage = fakeStorageAtRevision(3)
        const database = fixtureDatabaseWithMessages(3)
        const chat = database.characters[0].chats[0]
        chat.messagesFullyLoaded = true
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        chat.message.splice(1, 1)
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(messageDeletesOf(storage)).toEqual(['m-1'])
    })
})
