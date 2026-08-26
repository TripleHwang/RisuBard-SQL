import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ISqlStorage } from './ISqlStorage'
import {
    activateSqlPersistenceRuntime,
    flushSqlDirtyChanges,
    markSqlMessageDirty,
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
})
