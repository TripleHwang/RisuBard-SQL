/**
 * Persistence that `saveDb` used to provide and the metadata-first SQL path did
 * not.
 *
 * Every one of these is written from the SQL runtime's own public surface, in
 * the same shape `startMetadataPersistence` wires it up in production
 * (globalApi.svelte.ts).
 *
 * They were originally written the other way round -- asserting the defect --
 * and every assertion below is the inverse of the one it replaces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ISqlStorage } from './ISqlStorage'
import {
    activateSqlPersistenceRuntime,
    auditSqlCompatibilityDatabase,
    flushSqlDirtyChanges,
    initializeSqlCompatibilityBaseline,
    markSqlCharacterDirty,
    markSqlChatDirty,
    onSqlCommitSucceeded,
    onSqlPersistenceProblem,
    resetSqlPersistenceRuntimeForTesting,
    startSqlMetadataPersistence,
    type SqlPersistenceProblem,
} from './sqlPersistenceRuntime'

function fakeStorage(): ISqlStorage {
    return {
        getRevision: vi.fn(() => 1),
        commit: vi.fn(async () => ({ revision: 2 })),
    } as unknown as ISqlStorage
}

/** The live graph as metadata-first startup installs it. */
function fixtureDatabase() {
    return {
        username: 'User',
        theme: '',
        characters: [],
        botPresets: [],
        pluginCustomStorage: { 'my-plugin::token': 'before' },
    } as any
}

/** Installs the unload listeners exactly as `startMetadataPersistence` does. */
function installUnloadListeners() {
    const listeners = new Map<string, () => void>()
    startSqlMetadataPersistence(
        { addEventListener: (type: string, listener: () => void) => listeners.set(type, listener) } as any,
        () => {},
    )
    return listeners
}

/** Let the `void`-ed unload flush settle. */
async function settle() {
    await flushSqlDirtyChanges()
    await Promise.resolve()
}

afterEach(() => {
    onSqlCommitSucceeded(null)
    onSqlPersistenceProblem(null)
    resetSqlPersistenceRuntimeForTesting()
})

describe('metadata-first persistence gaps', () => {
    /**
     * `markSqlRootDirty` has exactly one caller in the whole app --
     * `auditSqlCompatibilityDatabase` -- so a settings change is invisible to
     * persistence until the ~10s idle audit notices it. The unload handler
     * flushed the dirty registry without auditing first, so the change was not
     * merely delayed: it was gone.
     */
    it('keeps a settings change made since the last audit when the tab closes', async () => {
        const storage = fakeStorage()
        const database = fixtureDatabase()
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)
        const listeners = installUnloadListeners()

        // The user edits a setting. No audit has run since.
        database.username = 'Renamed'

        listeners.get('pagehide')!()
        await settle()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            root: expect.objectContaining({
                upserts: expect.arrayContaining([{ key: 'username', value: 'Renamed' }]),
            }),
        }))
    })

    it('writes that same change when the audit runs before the flush', async () => {
        const storage = fakeStorage()
        const database = fixtureDatabase()
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)

        database.username = 'Renamed'
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            root: expect.objectContaining({
                upserts: expect.arrayContaining([{ key: 'username', value: 'Renamed' }]),
            }),
        }))
    })

    /**
     * Same hole, on the plugin scope. A plugin's `pluginStorage.setItem` writes
     * straight into `db.pluginCustomStorage` and marks nothing;
     * `markSqlPluginStorageDirty` likewise has no caller outside the audit.
     */
    it('keeps a plugin storage write made since the last audit when the tab closes', async () => {
        const storage = fakeStorage()
        const database = fixtureDatabase()
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)
        const listeners = installUnloadListeners()

        database.pluginCustomStorage['my-plugin::token'] = 'after'

        listeners.get('pagehide')!()
        await settle()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            pluginStorage: expect.objectContaining({
                upserts: [{ key: 'my-plugin::token', value: 'after' }],
            }),
        }))
    })

    /**
     * A dirty chat that is still a bootstrap summary is refused AND retained:
     * `commitDirtyScopes` re-marks it and hydrates it so the next flush can
     * write the whole record. A dirty CHARACTER in the same state was refused
     * with a bare `console.error` and no retain callback, so `acknowledge`
     * cleared the mark and the edit was gone for the session.
     *
     * Reachable from `removeChar('normal')` (characters.ts), which sets
     * `trashTime` on a character the user may never have opened and marks it
     * dirty without hydrating it first.
     */
    it('keeps the mark for a character that is still a bootstrap summary', async () => {
        const storage = fakeStorage()
        const database = fixtureDatabase()
        database.characters = [{ chaId: 'c1', name: 'Nia', detailsLoaded: false, chats: [], trashTime: 1700000000000 }]
        activateSqlPersistenceRuntime(storage, database)
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

        markSqlCharacterDirty('c1')
        await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()

        // The character is loaded later in the session. The retained mark is
        // what lets this flush write the record the user actually edited.
        database.characters[0].detailsLoaded = true
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            characters: [expect.objectContaining({ id: 'c1' })],
        }))
        errors.mockRestore()
    })

    it('keeps the mark for a chat refused in the same state', async () => {
        const storage = fakeStorage()
        const database = fixtureDatabase()
        database.characters = [{
            chaId: 'c1', name: 'Nia', detailsLoaded: true,
            chats: [{ id: 'chat-1', name: 'renamed', detailsLoaded: false, message: [] }],
        }]
        activateSqlPersistenceRuntime(storage, database)
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

        markSqlChatDirty('c1', 'chat-1')
        await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()

        database.characters[0].chats[0].detailsLoaded = true
        await flushSqlDirtyChanges()

        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            chats: [expect.objectContaining({ id: 'chat-1', characterId: 'c1' })],
        }))
        errors.mockRestore()
    })
})

describe('announcing a write to the other tabs on this device', () => {
    it('fires for a commit that reached storage and not for an empty flush', async () => {
        const storage = fakeStorage()
        const database = fixtureDatabase()
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)
        let writes = 0
        onSqlCommitSucceeded(() => { writes += 1 })

        // Nothing changed: a flush that commits nothing must not evict the
        // other tab, and flushes with nothing to do are the common case.
        await flushSqlDirtyChanges()
        expect(writes).toBe(0)

        database.username = 'Renamed'
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()
        expect(writes).toBe(1)

        onSqlCommitSucceeded(null)
    })
})

/**
 * `saveDb` counted consecutive failures and raised an alert at five, and the
 * `risu-session-deactivated` listener that answers a 423 was the only one in the
 * codebase. Both were dead in this mode, so a permanently failing commit loop
 * was a `console.error` and a five-second retry that never stopped, behind a
 * spinner that clears itself in a `finally`.
 */
describe('a commit that keeps failing', () => {
    function failingStorage(error: unknown): ISqlStorage {
        return {
            getRevision: vi.fn(() => 1),
            commit: vi.fn(async () => { throw error }),
        } as unknown as ISqlStorage
    }

    async function flushIgnoringFailure() {
        await flushSqlDirtyChanges().catch(() => undefined)
    }

    it('tells the user once it has failed as often as the legacy alert allowed', async () => {
        const storage = failingStorage(new Error('server is offline'))
        const database = fixtureDatabase()
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)
        const problems: SqlPersistenceProblem[] = []
        onSqlPersistenceProblem((problem) => problems.push(problem))

        for (let attempt = 1; attempt <= 5; attempt += 1) {
            database.username = `Renamed ${attempt}`
            auditSqlCompatibilityDatabase(database)
            await flushIgnoringFailure()
            // Silence until the legacy threshold, then exactly one message.
            expect(problems).toHaveLength(attempt < 5 ? 0 : 1)
        }
        expect(problems[0].kind).toBe('commit-failing')
        expect(problems[0].failures).toBe(5)
    })

    /**
     * A 423 is another session holding the writer lock. Every retry gets the
     * same answer, so retrying is not recovery, it is a silent stop.
     */
    it('stops and reports on a writer-lock refusal instead of retrying forever', async () => {
        vi.useFakeTimers()
        try {
            const locked = Object.assign(new Error('SQL commit failed (423)'), { status: 423 })
            const storage = failingStorage(locked)
            const database = fixtureDatabase()
            activateSqlPersistenceRuntime(storage, database)
            initializeSqlCompatibilityBaseline(database)
            const problems: SqlPersistenceProblem[] = []
            onSqlPersistenceProblem((problem) => problems.push(problem))

            database.username = 'Renamed'
            auditSqlCompatibilityDatabase(database)
            await flushIgnoringFailure()

            expect(problems.map((problem) => problem.kind)).toEqual(['session-deactivated'])
            expect(storage.commit).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(30_000)
            expect(storage.commit).toHaveBeenCalledTimes(1)
        } finally {
            vi.useRealTimers()
        }
    })

    it('still retries an ordinary failure', async () => {
        vi.useFakeTimers()
        try {
            const storage = failingStorage(new Error('network blip'))
            const database = fixtureDatabase()
            activateSqlPersistenceRuntime(storage, database)
            initializeSqlCompatibilityBaseline(database)

            database.username = 'Renamed'
            auditSqlCompatibilityDatabase(database)
            await flushIgnoringFailure()

            expect(storage.commit).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(6_000)
            expect((storage.commit as any).mock.calls.length).toBeGreaterThan(1)
        } finally {
            vi.useRealTimers()
        }
    })
})
