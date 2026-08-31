/**
 * What the five-second audit loop hands the garbage collector.
 *
 * `measure-baseline-heap.bench.ts` answers "what does the standing baseline
 * cost to hold", which is a floor and is unavoidable: an exact change detector
 * needs a copy of what it is comparing against. This one answers the other
 * half, which is not a floor and was the larger cost on a phone -- what each
 * pass ALLOCATES and then abandons.
 *
 * The distinction matters because of where the garbage ends up. A fingerprint
 * produced by a pass used to be referenced until the next pass replaced it,
 * five seconds later. On any generational collector that is long enough to
 * survive several scavenges and be promoted into the old generation, where
 * reclaiming it needs a major collection -- so the loop was manufacturing
 * ~0.5 MiB/s of promoted-then-dead string out of a database where almost
 * nothing had changed. A fingerprint that is carried over instead dies inside
 * the pass that made it and never leaves the nursery.
 *
 * What this harness can and cannot show. The counted numbers -- how many
 * fingerprints a pass carried over, and therefore how many bytes it added to
 * the heap for the next five seconds -- are exact and reproduce every run. The
 * collector numbers are not: driving enough scavenges on a desktop V8 heap
 * takes an order of magnitude more allocation than the audit itself makes, so
 * the audit's share of GC time sits below the noise floor of anything measured
 * here, and the `old-space growth` row swings either way between runs. Both are
 * printed, and only the first is evidence.
 *
 * Run with:
 *   NODE_OPTIONS=--expose-gc npx vitest run --config vitest.config.perf.ts scripts/perf/measure-audit-allocation.bench.ts
 */
import { PerformanceObserver } from 'node:perf_hooks'
import { getHeapSpaceStatistics } from 'node:v8'
import { afterEach, describe, it } from 'vitest'

import {
    auditSqlCompatibilityDatabase,
    initializeSqlCompatibilityBaseline,
    resetSqlPersistenceRuntimeForTesting,
    sqlCompatibilityBaselineFootprint,
} from '../../src/ts/storage/sql/sqlPersistenceRuntime'
import { buildKoreanDatabase, SHAPES, koreanText } from './koreanFixture'

/** Five minutes of the production loop. */
const PASSES = 60
const gc = (globalThis as { gc?: () => void }).gc
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

function settledHeap(): number {
    if (!gc) return process.memoryUsage().heapUsed
    for (let pass = 0; pass < 4; pass++) gc()
    return process.memoryUsage().heapUsed
}

/**
 * Bytes live in the old generation right now.
 *
 * This is the space a fingerprint reaches by being referenced for five seconds
 * -- long enough to survive the scavenges that would otherwise have reclaimed
 * it for nothing. Growth here across a run of idle passes is promotion, which
 * is the cost the carry-over exists to remove; reclaiming it needs a major
 * collection, and a major collection is the one a phone feels.
 */
function oldSpaceUsedBytes(): number {
    const space = getHeapSpaceStatistics().find((entry) => entry.space_name === 'old_space')
    return space ? space.space_used_size : 0
}

type GcTally = { major: number; minor: number; otherKinds: number; totalMs: number }

/**
 * Counts collections and their pause time while `run` executes.
 *
 * `detail.kind` is V8's own classification; 1 is a scavenge (nursery) and 2 a
 * mark-sweep-compact (old generation). Which of the two a change moves is the
 * whole point: a scavenge is cheap and proportional to what SURVIVED it, a
 * major collection is not.
 */
async function tallyGc(run: () => void): Promise<GcTally> {
    const tally: GcTally = { major: 0, minor: 0, otherKinds: 0, totalMs: 0 }
    const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
            const kind = (entry as unknown as { detail?: { kind?: number } }).detail?.kind
            if (kind === 2) tally.major += 1
            else if (kind === 1) tally.minor += 1
            else tally.otherKinds += 1
            tally.totalMs += entry.duration
        }
    })
    observer.observe({ entryTypes: ['gc'] })
    run()
    // The observer delivers in a microtask/macrotask after the entries land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    observer.disconnect()
    return tally
}

const pending: string[] = []
function row(label: string, value: string): void {
    pending.push(`    ${label.padEnd(46)} ${value}`)
}
function flushReport(): void {
    if (pending.length) process.stdout.write(`${pending.join('\n')}\n`)
    pending.length = 0
}

afterEach(() => resetSqlPersistenceRuntimeForTesting())

describe('what the audit loop allocates, pass after pass', () => {
    for (const name of ['light', 'reporting', 'heavy', 'unwindowed'] as const) {
        it(`idle session, shape: ${name}`, async () => {
            const database = buildKoreanDatabase(SHAPES[name])
            initializeSqlCompatibilityBaseline(database)
            const footprint = sqlCompatibilityBaselineFootprint()!
            const before = settledHeap()
            const oldSpaceBefore = oldSpaceUsedBytes()

            const durations: number[] = []
            const tally = await tallyGc(() => {
                for (let pass = 0; pass < PASSES; pass++) {
                    const started = performance.now()
                    auditSqlCompatibilityDatabase(database)
                    durations.push(performance.now() - started)
                }
            })
            const grown = process.memoryUsage().heapUsed
            const oldSpaceGrowth = oldSpaceUsedBytes() - oldSpaceBefore
            const after = settledHeap()
            const steady = sqlCompatibilityBaselineFootprint()!

            const sorted = [...durations].sort((left, right) => left - right)
            pending.push(`\n  [${name}: ${PASSES} idle passes = ${PASSES * 5}s of the loop]`)
            row('baseline strings', String(footprint.entries))
            row('baseline retained (UTF-16)', mib(footprint.bytes))
            row('strings carried over on the last pass', `${steady.reused} of ${steady.entries}`)
            row('strings kept as new on the last pass', String(steady.entries - steady.reused))
            row('long-lived bytes added per pass',
                mib(steady.entries === 0 ? 0 : footprint.bytes * (steady.entries - steady.reused) / steady.entries))
            row('old-space growth over the run (promotion)', mib(oldSpaceGrowth))
            row('heap growth over the run, before GC', mib(grown - before))
            row('heap growth over the run, after GC', mib(after - before))
            row('major collections during the run', String(tally.major))
            row('minor collections during the run', String(tally.minor))
            row('total GC pause during the run', `${tally.totalMs.toFixed(1)} ms`)
            row('audit pass, median', `${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms`)
            row('audit pass, worst', `${Math.max(...durations).toFixed(1)} ms`)
            flushReport()
        })
    }

    /**
     * The other end of the range: a database that really is changing between
     * passes. Nothing can be carried over for a value that moved, so this is
     * the case where the two versions must agree -- and it is the check that
     * the carry-over is comparing rather than assuming.
     */
    it('a session editing one message between every pass, shape: reporting', async () => {
        const database = buildKoreanDatabase(SHAPES.reporting)
        initializeSqlCompatibilityBaseline(database)
        const footprint = sqlCompatibilityBaselineFootprint()!
        const openChat = database.characters
            .flatMap((character: any) => character.chats)
            .find((chat: any) => chat.message.length > 0)
        const before = settledHeap()

        const durations: number[] = []
        const tally = await tallyGc(() => {
            for (let pass = 0; pass < PASSES; pass++) {
                openChat.message[openChat.message.length - 1].data = koreanText(400, Math.random)
                const started = performance.now()
                auditSqlCompatibilityDatabase(database)
                durations.push(performance.now() - started)
            }
        })
        const after = settledHeap()
        const steady = sqlCompatibilityBaselineFootprint()!
        const sorted = [...durations].sort((left, right) => left - right)

        pending.push(`\n  [reporting, one message edited per pass]`)
        row('baseline strings', String(footprint.entries))
        row('strings carried over on the last pass', `${steady.reused} of ${steady.entries}`)
        row('strings kept as new on the last pass', String(steady.entries - steady.reused))
        row('heap growth over the run, after GC', mib(after - before))
        row('major collections during the run', String(tally.major))
        row('total GC pause during the run', `${tally.totalMs.toFixed(1)} ms`)
        row('audit pass, median', `${sorted[Math.floor(sorted.length / 2)].toFixed(1)} ms`)
        flushReport()
    })
})
