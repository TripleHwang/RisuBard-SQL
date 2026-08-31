/**
 * Instrumentation for the compatibility audit.
 *
 * These tests do not assert a budget -- nothing in this project has ever
 * measured one, which is exactly the problem. They assert that the numbers a
 * budget would be argued from actually get produced, and that producing them
 * cannot change what the audit marks.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ISqlStorage } from './ISqlStorage'
import {
    activateSqlPersistenceRuntime,
    auditSqlCompatibilityDatabase,
    flushSqlDirtyChanges,
    initializeSqlCompatibilityBaseline,
    resetSqlPersistenceRuntimeForTesting,
    sqlCompatibilityBaselineFootprint,
} from './sqlPersistenceRuntime'
import {
    resetRuntimePerformanceReportForTesting,
    runtimePerformanceReport,
} from '../../performance/performanceReport'

function databaseWith(options: { chats: number; messagesPerChat: number; body: string }) {
    return {
        characters: [{
            chaId: 'character-a',
            name: '캐릭터',
            chats: Array.from({ length: options.chats }, (_, chat) => ({
                id: `chat-${chat}`,
                name: `대화 ${chat}`,
                message: Array.from({ length: options.messagesPerChat }, (_, index) => ({
                    chatId: `chat-${chat}-m-${index}`,
                    role: index % 2 ? 'char' : 'user',
                    data: options.body,
                })),
            })),
        }],
        botPresets: [],
        pluginCustomStorage: {},
    } as any
}

afterEach(() => {
    resetSqlPersistenceRuntimeForTesting()
    resetRuntimePerformanceReportForTesting()
})

describe('compatibility audit cost reporting', () => {
    it('reports the baseline it retains, counted in UTF-16 bytes of its fingerprints', () => {
        resetRuntimePerformanceReportForTesting()
        initializeSqlCompatibilityBaseline(databaseWith({ chats: 1, messagesPerChat: 10, body: '한글'.repeat(50) }))

        const footprint = sqlCompatibilityBaselineFootprint()
        expect(footprint).not.toBeNull()
        // One string per message, plus the chat signature, the character and
        // the two non-structural roots this fixture has.
        expect(footprint!.entries).toBeGreaterThanOrEqual(10)
        // 100 Korean code units per message body alone, held as UTF-16.
        expect(footprint!.bytes).toBeGreaterThan(10 * 100 * 2)

        const memory = runtimePerformanceReport.export().memory.at(-1)
        expect(memory?.compatibilityBaselineBytes).toBe(footprint!.bytes)
        expect(memory?.compatibilityBaselineEntries).toBe(footprint!.entries)
    })

    it('records one duration sample per audit pass, including the first', () => {
        resetRuntimePerformanceReportForTesting()
        const database = databaseWith({ chats: 2, messagesPerChat: 5, body: '안녕하세요' })
        initializeSqlCompatibilityBaseline(database)
        auditSqlCompatibilityDatabase(database)
        auditSqlCompatibilityDatabase(database)

        const samples = runtimePerformanceReport.export().durations['compatibility-audit'] ?? []
        expect(samples).toHaveLength(3)
        for (const sample of samples) expect(sample).toBeGreaterThanOrEqual(0)
    })

    it('grows the retained baseline in proportion to resident messages', () => {
        // The claim this checks is the one that makes the audit a memory floor
        // rather than merely a CPU cost: what it keeps is a second full copy of
        // everything resident, so doubling residency doubles what is held.
        const body = '한국어 문장입니다.'.repeat(20)
        initializeSqlCompatibilityBaseline(databaseWith({ chats: 1, messagesPerChat: 100, body }))
        const small = sqlCompatibilityBaselineFootprint()!.bytes
        resetSqlPersistenceRuntimeForTesting()
        initializeSqlCompatibilityBaseline(databaseWith({ chats: 1, messagesPerChat: 200, body }))
        const large = sqlCompatibilityBaselineFootprint()!.bytes

        expect(large / small).toBeGreaterThan(1.9)
        expect(large / small).toBeLessThan(2.1)
    })

    /**
     * The allocation half of the cost, which the byte counter cannot show.
     *
     * `snapshotCompatibility` re-serialises everything resident on every pass,
     * and the pass then becomes the standing baseline. So the strings it
     * produces are not transient: each one is referenced for the whole five
     * seconds until the next pass replaces it, which on any generational
     * collector is long enough to be promoted out of the nursery and then
     * immediately abandoned. At the reporting shape that was 2.55 MiB of
     * promoted-then-dead string every five seconds, for a database where almost
     * nothing had changed.
     *
     * A fingerprint that is byte-identical to the one already held does not
     * need to be a second string. `reused` counts the ones carried over, and it
     * is the number that says how much of each pass's output is thrown away
     * again -- there is no way to observe string identity from JavaScript, so
     * this counter is the only evidence available in a test.
     */
    it('carries over every fingerprint that did not change, instead of holding a second copy', () => {
        const database = databaseWith({ chats: 3, messagesPerChat: 40, body: '한국어 문장입니다.'.repeat(20) })
        initializeSqlCompatibilityBaseline(database)
        const first = sqlCompatibilityBaselineFootprint()!
        // Nothing to carry over from on the very first pass.
        expect(first.reused).toBe(0)

        auditSqlCompatibilityDatabase(database)
        const idle = sqlCompatibilityBaselineFootprint()!

        expect(idle.entries).toBe(first.entries)
        expect(idle.reused).toBe(idle.entries)
    })

    it('keeps only the fingerprints that actually changed', () => {
        const database = databaseWith({ chats: 2, messagesPerChat: 20, body: '한국어 문장입니다.' })
        initializeSqlCompatibilityBaseline(database)
        auditSqlCompatibilityDatabase(database)

        database.characters[0].chats[0].message[3].data = '고쳐진 문장'
        auditSqlCompatibilityDatabase(database)
        const edited = sqlCompatibilityBaselineFootprint()!

        // Exactly one message fingerprint differs; everything else is carried.
        expect(edited.entries - edited.reused).toBe(1)
    })

    /**
     * The guard on the optimisation above.
     *
     * Carrying a fingerprint over is decided by comparing the two strings, so a
     * value that changed can never be carried -- but the two cases above would
     * also pass for an audit that had simply stopped looking at a scope, since
     * "unchanged" and "unwatched" produce the same counter. This one runs the
     * change all the way through to a commit: after an idle pass that carried
     * everything, an edit to a root key and an edit to a message body both
     * still reach storage.
     */
    it('carrying a fingerprint over cannot hide the next change to it', async () => {
        const storage = {
            getRevision: () => 3,
            commit: vi.fn(async () => ({ revision: 4 })),
        } as unknown as ISqlStorage
        const database = databaseWith({ chats: 1, messagesPerChat: 5, body: '본문' })
        database.username = '이름'
        activateSqlPersistenceRuntime(storage, database)
        initializeSqlCompatibilityBaseline(database)
        // The dirty registry is module state that outlives one test, so drain
        // whatever earlier cases in this file left marked before asserting that
        // an idle pass commits nothing.
        await flushSqlDirtyChanges()
        ;(storage.commit as ReturnType<typeof vi.fn>).mockClear()

        // An idle pass, whose whole output is carried over from the baseline.
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()
        expect(storage.commit).not.toHaveBeenCalled()
        expect(sqlCompatibilityBaselineFootprint()!.reused)
            .toBe(sqlCompatibilityBaselineFootprint()!.entries)

        database.username = '새 이름'
        database.characters[0].chats[0].message[1].data = '새 본문'
        auditSqlCompatibilityDatabase(database)
        await flushSqlDirtyChanges()

        const after = sqlCompatibilityBaselineFootprint()!
        expect(after.entries - after.reused).toBe(2)
        expect(storage.commit).toHaveBeenCalledWith(expect.objectContaining({
            root: { upserts: [{ key: 'username', value: '새 이름' }], deletes: [] },
            messages: [expect.objectContaining({
                id: 'chat-0-m-1',
                data: expect.objectContaining({ data: '새 본문' }),
            })],
        }))
    })

    it('holds no footprint before a baseline exists and none after release', () => {
        expect(sqlCompatibilityBaselineFootprint()).toBeNull()
        initializeSqlCompatibilityBaseline(databaseWith({ chats: 1, messagesPerChat: 1, body: '가' }))
        expect(sqlCompatibilityBaselineFootprint()).not.toBeNull()
        resetSqlPersistenceRuntimeForTesting()
        expect(sqlCompatibilityBaselineFootprint()).toBeNull()
    })
})
