/**
 * Measures what the compatibility audit costs today. Changes nothing.
 *
 * Run with:
 *   npx vitest run --config vitest.config.perf.ts
 *
 * Reported per shape: the wall time of one audit pass, the bytes of fingerprint
 * string the standing baseline holds, how much of each later pass is carried
 * over from it rather than kept as a second copy, and how that compares to the
 * database the baseline was taken from.
 */
import { afterEach, describe, it } from 'vitest'

import {
    auditSqlCompatibilityDatabase,
    initializeSqlCompatibilityBaseline,
    resetSqlPersistenceRuntimeForTesting,
    sqlCompatibilityBaselineFootprint,
} from '../../src/ts/storage/sql/sqlPersistenceRuntime'
import {
    buildKoreanDatabase, chatCount, residentMessageCount, SHAPES, utf8Bytes, koreanText,
} from './koreanFixture'

const PASSES = 9

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function mib(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

function row(label: string, value: string): void {
    process.stdout.write(`    ${label.padEnd(38)} ${value}\n`)
}

afterEach(() => resetSqlPersistenceRuntimeForTesting())

describe('compatibility audit, current state', () => {
    for (const [name, shape] of Object.entries(SHAPES)) {
        it(`shape: ${name}`, () => {
            const database = buildKoreanDatabase(shape)
            const wireBytes = utf8Bytes(database)

            const first = performance.now()
            initializeSqlCompatibilityBaseline(database)
            const firstPass = performance.now() - first
            const footprint = sqlCompatibilityBaselineFootprint()!

            // Steady state: no edits between passes, which is what the 5s loop
            // sees almost every time it runs. The diff finds nothing; the
            // snapshot is rebuilt in full regardless.
            const idle: number[] = []
            for (let pass = 0; pass < PASSES; pass++) {
                const started = performance.now()
                auditSqlCompatibilityDatabase(database)
                idle.push(performance.now() - started)
            }

            // One message edited, which is the cheapest thing a user can do
            // between two passes. Cost should be identical: the snapshot does
            // not know what changed until after it has re-serialised all of it.
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

            process.stdout.write(`\n  [${name}]\n`)
            row('characters / chats / resident msgs',
                `${database.characters.length} / ${chatCount(database)} / ${residentMessageCount(database)}`)
            row('database JSON (UTF-8, wire/disk)', mib(wireBytes))
            row('baseline fingerprint strings', String(footprint.entries))
            row('baseline retained (UTF-16)', mib(footprint.bytes))
            row('baseline / database ratio', `${(footprint.bytes / wireBytes).toFixed(2)}x`)
            row('first pass (cold)', `${firstPass.toFixed(1)} ms`)
            row('idle pass, median of ' + PASSES, `${median(idle).toFixed(1)} ms`)
            row('idle pass, worst', `${Math.max(...idle).toFixed(1)} ms`)
            row('one-message-edit pass, median', `${median(dirty).toFixed(1)} ms`)
            // What a pass leaves behind, which is not the same as what it
            // serialises. Every value is still fingerprinted on every pass; a
            // fingerprint that came out byte-identical is carried over from the
            // standing baseline and the new string dies inside the pass.
            const steady = sqlCompatibilityBaselineFootprint()!
            row('fingerprints carried over on the last pass', `${steady.reused} of ${steady.entries}`)
            row('long-lived bytes added per pass',
                mib(steady.entries === 0 ? 0 : steady.bytes * (steady.entries - steady.reused) / steady.entries))
            row('long-lived allocation rate at 5s loop',
                `${mib(steady.entries === 0 ? 0 : steady.bytes * (steady.entries - steady.reused) / steady.entries / 5)}/s`)
            row('node heapUsed after passes', mib(process.memoryUsage().heapUsed))
        })
    }

    it('where the pass time goes, at the reporting shape', () => {
        const database = buildKoreanDatabase(SHAPES.reporting)

        const timeOf = (label: string, run: () => void) => {
            const samples: number[] = []
            for (let pass = 0; pass < PASSES; pass++) {
                const started = performance.now()
                run()
                samples.push(performance.now() - started)
            }
            row(label, `${median(samples).toFixed(1)} ms`)
            return median(samples)
        }

        process.stdout.write('\n  [reporting: breakdown]\n')
        const resident = database.characters
            .flatMap((character: any) => character.chats)
            .flatMap((chat: any) => chat.message)
        const summaries = database.characters
            .flatMap((character: any) => character.chats)
            .map((chat: any) => ({ ...chat, message: undefined }))
        const characterMeta = database.characters.map((character: any) => ({ ...character, chats: undefined }))
        const rootKeys = Object.keys(database)
            .filter((key) => !['characters', 'pluginCustomStorage', 'botPresets', 'botPresetsId'].includes(key))

        timeOf(`stringify ${resident.length} resident messages`, () => {
            for (const message of resident) JSON.stringify(message)
        })
        timeOf(`stringify ${summaries.length} chat summaries`, () => {
            for (const chat of summaries) JSON.stringify(chat)
        })
        timeOf(`stringify ${characterMeta.length} characters`, () => {
            for (const character of characterMeta) JSON.stringify(character)
        })
        timeOf(`stringify ${rootKeys.length} root keys`, () => {
            for (const key of rootKeys) JSON.stringify(database[key])
        })
        timeOf(`stringify ${database.botPresets.length} presets`, () => {
            for (const preset of database.botPresets) JSON.stringify(preset)
        })

        // Same data, Latin-1. The gap is what an English fixture would have
        // hidden -- V8 serialises one-byte strings on a separate fast path.
        const asciiResident = JSON.parse(
            JSON.stringify(resident).replace(/[가-힣]/g, 'a'),
        )
        timeOf(`stringify the same messages as ASCII`, () => {
            for (const message of asciiResident) JSON.stringify(message)
        })
    })
})
