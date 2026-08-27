import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock(import('../../stores.svelte'), () => ({
    DBState: { db: { characters: [], enabledModules: [], modules: [] } },
    selIdState: { selId: 0 },
} as any))

import type { ISqlStorage } from './ISqlStorage'
import { beginHydration, endHydration } from '../hydrationState'
import { SqlRevisionConflictError } from './sqlCommit'
import { buildSqlDirtyCommit } from './sqlDirtyCommit'
import { applySqliteCommit } from './sqliteCommit'
import { createBlankChar } from '../../characters'
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
        beginHydration(JSON.stringify(['character-a', 'chat-a']))
        markSqlMessageDirty('chat-a', 'm-0', true)
        await Promise.resolve()
        endHydration(JSON.stringify(['character-a', 'chat-a']))
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

    it('preserves unloaded character and chat bodies while allowing summary metadata updates', async () => {
        const database = {
            characters: [{
                chaId: 'character-a', name: 'Renamed', image: 'new.png', detailsLoaded: false,
                chats: [{ id: 'chat-a', name: 'Moved chat', note: 'summary note', detailsLoaded: false, message: [] }],
            }], botPresets: [], pluginCustomStorage: {},
        } as any
        const commit = buildSqlDirtyCommit(database, {
            rootKeys: [], characterIds: ['character-a'],
            chats: [{ characterId: 'character-a', chatId: 'chat-a', manifest: false }],
            messages: [], messageManifestChatIds: [], messageDeletes: [], pluginStorageKeys: [], presetIds: [],
        }, 3)
        const statements: string[] = []
        await applySqliteCommit(commit, (sql) => { statements.push(sql) })

        expect(commit.characters[0]).toMatchObject({ replaceBody: false, position: 0 })
        expect(commit.chats[0]).toMatchObject({ replaceBody: false, position: 0 })
        expect(statements.some((sql) => /character_extension_nodes|character_tags|chat_extension_nodes/.test(sql))).toBe(false)

        database.characters[0].detailsLoaded = true
        database.characters[0].chats[0].detailsLoaded = true
        const loadedCommit = buildSqlDirtyCommit(database, {
            rootKeys: [], characterIds: ['character-a'],
            chats: [{ characterId: 'character-a', chatId: 'chat-a', manifest: false }],
            messages: [], messageManifestChatIds: [], messageDeletes: [], pluginStorageKeys: [], presetIds: [],
        }, 4)
        expect(loadedCommit.characters[0]).toMatchObject({ replaceBody: true })
        expect(loadedCommit.chats[0]).toMatchObject({ replaceBody: true })
    })

    it('persists bodies from a concrete newly created character and chat', async () => {
        const character = createBlankChar() as any
        character.chaId = 'new-character'
        character.desc = 'full character body'
        character.tags = ['imported-tag']
        character.chats[0].id = 'new-chat'
        character.chats[0].note = 'full chat body'
        const commit = buildSqlDirtyCommit({ characters: [character], botPresets: [], pluginCustomStorage: {} } as any, {
            rootKeys: [], characterIds: ['new-character'],
            chats: [{ characterId: 'new-character', chatId: 'new-chat', manifest: false }],
            messages: [], messageManifestChatIds: [], messageDeletes: [], pluginStorageKeys: [], presetIds: [],
        }, 3)
        const statements: string[] = []
        await applySqliteCommit(commit, (sql) => { statements.push(sql) })

        expect(commit.characters[0]).toMatchObject({ replaceBody: true })
        expect(commit.chats[0]).toMatchObject({ replaceBody: true })
        expect(statements.some((sql) => /character_extension_nodes|character_tags|chat_extension_nodes/.test(sql))).toBe(true)
    })
})
