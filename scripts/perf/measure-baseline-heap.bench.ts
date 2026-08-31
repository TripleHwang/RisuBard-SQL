/**
 * What `compatibilityBaseline` actually costs the process, measured rather
 * than counted.
 *
 * `sqlCompatibilityBaselineFootprint()` counts the UTF-16 bytes of the
 * fingerprint strings, which is exact but excludes the Maps that hold them.
 * This takes the difference in retained heap across a forced GC, which
 * includes everything.
 *
 * Needs a collectable heap:
 *   NODE_OPTIONS=--expose-gc npx vitest run --config vitest.config.perf.ts scripts/perf/measure-baseline-heap.bench.ts
 * Without --expose-gc it says so and reports the counted bytes only.
 */
import { afterEach, describe, it } from 'vitest'

import {
    initializeSqlCompatibilityBaseline,
    resetSqlPersistenceRuntimeForTesting,
    sqlCompatibilityBaselineFootprint,
} from '../../src/ts/storage/sql/sqlPersistenceRuntime'
import { buildKoreanDatabase, SHAPES } from './koreanFixture'

const gc = (globalThis as { gc?: () => void }).gc

function settledHeap(): number {
    if (!gc) return process.memoryUsage().heapUsed
    for (let pass = 0; pass < 4; pass++) gc()
    return process.memoryUsage().heapUsed
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`

afterEach(() => resetSqlPersistenceRuntimeForTesting())

describe('retained cost of the standing baseline', () => {
    for (const name of ['light', 'reporting', 'heavy', 'unwindowed'] as const) {
        it(`shape: ${name}`, () => {
            const lines: string[] = []
            const database = buildKoreanDatabase(SHAPES[name])
            const beforeDatabase = settledHeap()
            void database.characters.length
            const withDatabase = settledHeap()

            initializeSqlCompatibilityBaseline(database)
            const withBaseline = settledHeap()
            const counted = sqlCompatibilityBaselineFootprint()!

            lines.push(`\n  [${name}]`)
            lines.push(`    ${'counted fingerprint bytes (UTF-16)'.padEnd(42)} ${mib(counted.bytes)}`)
            lines.push(`    ${'fingerprint strings'.padEnd(42)} ${counted.entries}`)
            if (gc) {
                lines.push(`    ${'heap holding the database alone'.padEnd(42)} ${mib(withDatabase - beforeDatabase + beforeDatabase)}`)
                lines.push(`    ${'heap added by the baseline (measured)'.padEnd(42)} ${mib(withBaseline - withDatabase)}`)
                lines.push(`    ${'measured / counted'.padEnd(42)} ${((withBaseline - withDatabase) / counted.bytes).toFixed(2)}x`)
            } else {
                lines.push(`    ${'measured heap'.padEnd(42)} unavailable: run with NODE_OPTIONS=--expose-gc`)
            }
            process.stdout.write(`${lines.join('\n')}\n`)
        })
    }
})
