/**
 * What a character carrying thousands of assets actually costs here.
 *
 * A sibling fork reports that characters and modules with thousands of assets
 * made startup slow and browser memory large, and fixed it by not shipping the
 * whole asset list to the client. Our storage layer is different -- characters
 * bootstrap as SUMMARIES (`readCharacterSummaries` in relational-sqlite.cjs
 * returns nine columns and no extension nodes), so the asset list is not on the
 * startup path at all. It arrives only when `ensureCharacterHydrated` runs for a
 * character the user opened, and then stays resident for the session.
 *
 * So the question is not "what does startup cost" but "what does opening one
 * asset-heavy character cost, and what does keeping it open cost per second".
 * This measures both, against a character with a handful of assets.
 *
 * Nothing here asserts a budget. It prints numbers.
 *
 * Run with:
 *   NODE_OPTIONS=--expose-gc npx vitest run --config vitest.config.perf.ts scripts/perf/measure-character-assets.bench.ts
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, it } from 'vitest'

import {
    MAX_RELATIONAL_NODE_ROWS_PER_VALUE,
    measureRelationalValue,
    encodeRelationalNodeRows,
} from '../../src/ts/storage/sql/relationalNodeCodec'
import { applySqliteCommit } from '../../src/ts/storage/sql/sqliteCommit'
import { createEmptySqlCommit, sqlCharacterData } from '../../src/ts/storage/sql/sqlCommit'
import {
    auditSqlCompatibilityDatabase,
    initializeSqlCompatibilityBaseline,
    resetSqlPersistenceRuntimeForTesting,
    sqlCompatibilityBaselineFootprint,
} from '../../src/ts/storage/sql/sqlPersistenceRuntime'
import { koreanText } from './koreanFixture'

const require = createRequire(import.meta.url)
const { createRelationalSqlite } = require('../../server/node/relational-sqlite.cjs')

const gc = (globalThis as { gc?: () => void }).gc
const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(3)} MiB`
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`

function settledHeap(): number {
    if (!gc) return process.memoryUsage().heapUsed
    for (let pass = 0; pass < 4; pass++) gc()
    return process.memoryUsage().heapUsed
}

function makeRandom(seed: number): () => number {
    let state = seed >>> 0 || 1
    return () => {
        state ^= state << 13; state >>>= 0
        state ^= state >>> 17
        state ^= state << 5; state >>>= 0
        return state / 0x1_0000_0000
    }
}

/**
 * Asset names the way real characters carry them.
 *
 * `saveAsset` stores under `assets/<sha256hex>.<ext>` and the NAME is the
 * original filename the user dropped in -- so the tuple is a short human name
 * and a 69-character content-addressed path. A quarter of the names are Korean,
 * because that is what the reporting users of this fork upload and because a
 * two-byte string is off `JSON.stringify`'s one-byte fast path, which is the
 * part an all-ASCII fixture cannot see.
 */
const POSES = ['smile', 'sad', 'angry', 'blush', 'shy', 'surprise', 'wink', 'cry', 'laugh', 'neutral']
const OUTFITS = ['casual', 'uniform', 'swimsuit', 'pajama', 'formal', 'winter', 'summer']
const EXTS = ['png', 'webp', 'gif', 'mp4', 'mp3']

function assetTuples(count: number, random: () => number, prefix: string): [string, string, string][] {
    const out: [string, string, string][] = []
    for (let index = 0; index < count; index++) {
        const ext = EXTS[Math.floor(random() * EXTS.length)]
        const korean = index % 4 === 0
        const name = korean
            ? `${koreanText(5, random)}_${index}.${ext}`
            : `${prefix}_${OUTFITS[index % OUTFITS.length]}_${POSES[index % POSES.length]}_${String(index).padStart(4, '0')}.${ext}`
        const hex = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('')
        out.push([name, `assets/${hex}.${ext}`, ext])
    }
    return out
}

function emotionTuples(count: number, random: () => number): [string, string][] {
    return Array.from({ length: count }, (_unused, index) => {
        const hex = Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join('')
        return [
            index % 4 === 0 ? koreanText(4, random) : `${POSES[index % POSES.length]}${index}`,
            `assets/${hex}.png`,
        ] as [string, string]
    })
}

/** A character of ordinary weight apart from its asset lists. */
function buildCharacter(options: {
    id: string
    assets: number
    emotions: number
    seed?: number
}): any {
    const random = makeRandom(options.seed ?? 20_260_904)
    return {
        chaId: options.id,
        type: 'character',
        name: koreanText(8, random),
        image: `assets/${options.id}-portrait.png`,
        desc: koreanText(1_200, random),
        notes: koreanText(200, random),
        firstMessage: koreanText(600, random),
        alternateGreetings: [koreanText(500, random), koreanText(500, random)],
        personality: koreanText(300, random),
        scenario: koreanText(300, random),
        exampleMessage: koreanText(900, random),
        creatorNotes: koreanText(250, random),
        systemPrompt: koreanText(400, random),
        postHistoryInstructions: koreanText(200, random),
        tags: [koreanText(4, random), koreanText(4, random)],
        creator: koreanText(6, random),
        characterVersion: '1.0',
        chatPage: 0,
        viewScreen: 'emotion',
        bias: [],
        sdData: [],
        chatFolders: [],
        globalLore: Array.from({ length: 12 }, (_unused, entry) => ({
            key: koreanText(10, random), comment: koreanText(20, random),
            content: koreanText(400, random), mode: 'normal', insertorder: entry,
            alwaysActive: false, secondkey: '', selective: false,
        })),
        customscript: [],
        triggerscript: [],
        utilityBot: false,
        emotionImages: emotionTuples(options.emotions, random),
        additionalAssets: assetTuples(options.assets, random, 'char'),
        vits: null,
        chats: [{
            id: `${options.id}-chat-00`, name: koreanText(12, random), note: '',
            localLore: [], lastDate: 1_700_000_000_000, fmIndex: -1,
            message: [], messagesLoaded: false, messagesFullyLoaded: false,
        }],
        detailsLoaded: true,
    }
}

const SHAPES = [
    { label: 'handful (6 assets)', assets: 6, emotions: 6 },
    { label: '500 assets', assets: 500, emotions: 60 },
    { label: '2,000 assets', assets: 2_000, emotions: 200 },
    { label: '4,000 assets', assets: 4_000, emotions: 400 },
    // Past MAX_RELATIONAL_NODE_ROWS_PER_VALUE, so this one is stored as a
    // single canonical-JSON row rather than exploded into nodes.
    { label: '8,000 assets (spills)', assets: 8_000, emotions: 800 },
]

const roots: string[] = []
const storages: { close(): void }[] = []
afterEach(() => {
    for (const storage of storages.splice(0)) storage.close()
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    resetSqlPersistenceRuntimeForTesting()
})

function freshStorage() {
    const root = mkdtempSync(join(tmpdir(), 'risu-asset-bench-'))
    roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root })
    storages.push(storage)
    return { storage, root }
}

async function statementsForCharacter(character: any) {
    const commit = createEmptySqlCommit(0, 'bench')
    commit.characters.push({ id: character.chaId, position: 0, data: sqlCharacterData(character) })
    const statements: { sql: string; bind: unknown[] }[] = []
    await applySqliteCommit(commit, (sql, bind = []) => { statements.push({ sql, bind }) })
    return statements
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)]
}

describe('a character carrying thousands of assets', () => {
    it('costs this much to store, and spills past this many', async () => {
        console.log('')
        console.log(`  spill threshold: ${MAX_RELATIONAL_NODE_ROWS_PER_VALUE.toLocaleString()} node rows per value`)
        console.log('  shape                     nodes      spilled   JSON bytes   asset share   statements')
        for (const shape of SHAPES) {
            const character = buildCharacter({ id: `c-${shape.assets}`, assets: shape.assets, emotions: shape.emotions })
            const data = sqlCharacterData(character)
            const nodes = measureRelationalValue(data)
            const rows = encodeRelationalNodeRows(data)
            const spilled = rows.length === 1
            const json = JSON.stringify(data)!.length
            const assetsOnly = JSON.stringify({
                additionalAssets: character.additionalAssets,
                emotionImages: character.emotionImages,
            })!.length
            const statements = await statementsForCharacter(character)
            console.log(
                `  ${shape.label.padEnd(22)} ${String(nodes).padStart(9)}   ${(spilled ? 'JSON' : 'nodes').padStart(6)}   ` +
                `${String(json).padStart(10)}   ${((assetsOnly / json) * 100).toFixed(1).padStart(10)}%   ${String(statements.length).padStart(10)}`,
            )
        }
    })

    it('costs this much to hydrate, server read through client rebuild', async () => {
        console.log('')
        console.log('  shape                    write ms   loadCharacter ms   payload bytes   db file      bootstrap')
        for (const shape of SHAPES) {
            const { storage, root } = freshStorage()
            const character = buildCharacter({ id: `c-${shape.assets}`, assets: shape.assets, emotions: shape.emotions })
            const statements = await statementsForCharacter(character)
            const writeStart = performance.now()
            storage.commit({ baseRevision: 0, action: 'bench', statements })
            const writeMs = performance.now() - writeStart

            // Warm, then take the median of real reads.
            storage.loadCharacter(character.chaId)
            const samples: number[] = []
            for (let pass = 0; pass < 15; pass++) {
                const start = performance.now()
                storage.loadCharacter(character.chaId)
                samples.push(performance.now() - start)
            }
            const payload = JSON.stringify(storage.loadCharacter(character.chaId))!.length
            let dbBytes = 0
            try { dbBytes = statSync(join(root, 'sql', 'risu-standalone.sqlite3')).size } catch { dbBytes = 0 }
            // What bootstrap actually ships for this character: summaries only.
            const bootstrapBytes = JSON.stringify(storage.bootstrap().characters)!.length
            console.log(
                `  ${shape.label.padEnd(22)} ${writeMs.toFixed(2).padStart(8)}   ${median(samples).toFixed(3).padStart(16)}   ` +
                `${String(payload).padStart(13)}   ${kib(dbBytes).padStart(10)}   ${String(bootstrapBytes).padStart(9)}`,
            )
            for (const s of storages.splice(0)) s.close()
            rmSync(roots.pop()!, { recursive: true, force: true })
        }
    })

    it('costs this much per five-second compatibility audit pass', () => {
        console.log('')
        console.log('  A library of 40 characters. Only the opened ones are hydrated; the rest')
        console.log('  are bootstrap summaries with no asset list at all.')
        console.log('')
        console.log('  shape                   opened   audit ms (median of 20)   baseline bytes   entries')
        for (const shape of SHAPES) {
            for (const opened of [1, 3]) {
                resetSqlPersistenceRuntimeForTesting()
                const random = makeRandom(7)
                const characters = Array.from({ length: 40 }, (_unused, index) => {
                    if (index < opened) {
                        return buildCharacter({
                            id: `c-${index}`, assets: shape.assets, emotions: shape.emotions,
                            seed: 1_000 + index,
                        })
                    }
                    // What bootstrap actually ships for a character never opened.
                    return {
                        chaId: `c-${index}`, type: 'character', name: koreanText(8, random),
                        image: `assets/c-${index}.png`, detailsLoaded: false, chatPage: 0,
                        chats: [{
                            id: `c-${index}-chat-00`, name: koreanText(10, random), note: '',
                            lastDate: 1_700_000_000_000, message: [],
                            messagesLoaded: false, messagesFullyLoaded: false,
                        }],
                    }
                })
                const database: any = {
                    characters, botPresets: [], botPresetsId: 0, pluginCustomStorage: {},
                    username: koreanText(6, random), mainPrompt: koreanText(2_000, random),
                }
                initializeSqlCompatibilityBaseline(database)
                const samples: number[] = []
                for (let pass = 0; pass < 20; pass++) {
                    const start = performance.now()
                    auditSqlCompatibilityDatabase(database)
                    samples.push(performance.now() - start)
                }
                const footprint = sqlCompatibilityBaselineFootprint()
                console.log(
                    `  ${shape.label.padEnd(22)} ${String(opened).padStart(6)}   ${median(samples).toFixed(3).padStart(22)}   ` +
                    `${mib(footprint?.bytes ?? 0).padStart(14)}   ${String(footprint?.entries ?? 0).padStart(7)}`,
                )
            }
        }
    })

    it('holds this much resident heap', () => {
        console.log('')
        console.log('  shape                   character in heap   +standing audit baseline')
        for (const shape of SHAPES) {
            resetSqlPersistenceRuntimeForTesting()
            const before = settledHeap()
            let character: any = buildCharacter({ id: 'c-heap', assets: shape.assets, emotions: shape.emotions })
            const afterBuild = settledHeap()
            const database: any = {
                characters: [character], botPresets: [], botPresetsId: 0, pluginCustomStorage: {},
            }
            initializeSqlCompatibilityBaseline(database)
            auditSqlCompatibilityDatabase(database)
            const afterAudit = settledHeap()
            console.log(
                `  ${shape.label.padEnd(22)} ${mib(afterBuild - before).padStart(17)}   ${mib(afterAudit - afterBuild).padStart(24)}`,
            )
            character = null
            void character
        }
    })
})
