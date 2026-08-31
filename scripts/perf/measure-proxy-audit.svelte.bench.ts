/**
 * The same audit, over the object the user actually edits.
 *
 * `measure-current-state.bench.ts` fingerprints a plain object graph. The
 * running application does not have one: `setDatabase` wraps the database in a
 * Svelte 5 `$state` proxy, and every property read `JSON.stringify` performs
 * during the audit goes through that proxy's `get` trap -- which lazily creates
 * a reactive source per property and per array index the first time it is
 * touched, and reads one every time after.
 *
 * So a plain-object measurement of this audit is the same category of mistake
 * as an English fixture, and it is worth its own number rather than an
 * argument. Nothing here changes behaviour; it only measures.
 *
 * Run with: npx vitest run --config vitest.config.perf.ts
 */
import { afterEach, describe, it } from 'vitest'

import {
    auditSqlCompatibilityDatabase,
    initializeSqlCompatibilityBaseline,
    resetSqlPersistenceRuntimeForTesting,
    sqlCompatibilityBaselineFootprint,
} from '../../src/ts/storage/sql/sqlPersistenceRuntime'
import { buildKoreanDatabase, koreanText, residentMessageCount, SHAPES } from './koreanFixture'

const PASSES = 9

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function row(label: string, value: string): void {
    process.stdout.write(`    ${label.padEnd(38)} ${value}\n`)
}

afterEach(() => resetSqlPersistenceRuntimeForTesting())

describe('compatibility audit over a $state proxy', () => {
    for (const name of ['light', 'reporting', 'heavy', 'unwindowed'] as const) {
        it(`shape: ${name}`, () => {
            const raw = buildKoreanDatabase(SHAPES[name])
            const holder = $state({ db: raw })
            const database = holder.db as any

            const cold = performance.now()
            initializeSqlCompatibilityBaseline(database)
            const firstPass = performance.now() - cold
            const footprint = sqlCompatibilityBaselineFootprint()!

            const idle: number[] = []
            for (let pass = 0; pass < PASSES; pass++) {
                const started = performance.now()
                auditSqlCompatibilityDatabase(database)
                idle.push(performance.now() - started)
            }

            const openChat = database.characters
                .flatMap((character: any) => character.chats)
                .find((chat: any) => chat.message.length > 0)
            const dirty: number[] = []
            for (let pass = 0; pass < PASSES; pass++) {
                openChat.message[openChat.message.length - 1].data = koreanText(400, Math.random)
                const started = performance.now()
                auditSqlCompatibilityDatabase(database)
                dirty.push(performance.now() - started)
            }

            process.stdout.write(`\n  [${name} / $state proxy]\n`)
            row('resident messages', String(residentMessageCount(database)))
            row('baseline fingerprint strings', String(footprint.entries))
            row('baseline retained (UTF-16)', `${(footprint.bytes / 1024 / 1024).toFixed(2)} MiB`)
            row('first pass (cold, creates the sources)', `${firstPass.toFixed(1)} ms`)
            row('idle pass, median of ' + PASSES, `${median(idle).toFixed(1)} ms`)
            row('idle pass, worst', `${Math.max(...idle).toFixed(1)} ms`)
            row('one-message-edit pass, median', `${median(dirty).toFixed(1)} ms`)
        })
    }

    it('proxy overhead, isolated', () => {
        const raw = buildKoreanDatabase(SHAPES.reporting)
        const holder = $state({ db: buildKoreanDatabase(SHAPES.reporting) })
        const proxied = holder.db as any

        const timeOf = (label: string, run: () => void) => {
            const samples: number[] = []
            for (let pass = 0; pass < PASSES; pass++) {
                const started = performance.now()
                run()
                samples.push(performance.now() - started)
            }
            row(label, `${median(samples).toFixed(1)} ms`)
        }

        const residentOf = (database: any) => database.characters
            .flatMap((character: any) => character.chats)
            .flatMap((chat: any) => chat.message)

        // Warm the proxy once so the measured passes are steady-state reads
        // rather than one-time source creation.
        JSON.stringify(proxied)

        process.stdout.write('\n  [reporting: plain vs proxied]\n')
        const plainMessages = residentOf(raw)
        const proxiedMessages = residentOf(proxied)
        timeOf(`stringify ${plainMessages.length} messages, plain`, () => {
            for (const message of plainMessages) JSON.stringify(message)
        })
        timeOf(`stringify ${proxiedMessages.length} messages, proxied`, () => {
            for (const message of proxiedMessages) JSON.stringify(message)
        })
        timeOf('stringify whole database, plain', () => { JSON.stringify(raw) })
        timeOf('stringify whole database, proxied', () => { JSON.stringify(proxied) })
    })
})
