import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'

const mocks = vi.hoisted(() => ({
    database: {
        current: {
            presetRegex: [] as unknown[],
            dynamicAssets: false,
            characters: [] as unknown[],
        },
    },
}))

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../stores.svelte', () => ({
    CharEmotion: writable({} as Record<string, unknown>),
    selectedCharID: writable(0),
}))
vi.mock('../storage/database.svelte', () => ({
    getDatabase: vi.fn(() => mocks.database.current),
    getCurrentCharacter: vi.fn(() => null),
    getCurrentChat: vi.fn(() => null),
}))
vi.mock('../globalApi.svelte', () => ({ downloadFile: vi.fn() }))
vi.mock('../alert', () => ({ alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('../util', () => ({ selectSingleFile: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({
    assetRegex: /{{(raw|img|image|video|audio|bgm|emotion|asset|video-img|source|path)::(.+?)}}/g,
    // Identity: these tests are about flag handling, not CBS expansion.
    risuChatParser: (data: string) => data,
}))
vi.mock('./modules', () => ({
    getModuleAssets: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
}))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: class {} }))
vi.mock('./scriptings', () => ({ runLuaEditTrigger: vi.fn(async (_c: unknown, _m: unknown, data: string) => data) }))
vi.mock('../plugins/plugins.svelte', () => ({
    pluginV2: {
        editinput: new Set(),
        editoutput: new Set(),
        editprocess: new Set(),
        editdisplay: new Set(),
    },
}))
vi.mock('./triggers', () => ({ runTrigger: vi.fn(async () => null) }))

import { processScriptFull, resetScriptCache } from './scripts'

type ScriptSpec = {
    in: string
    out: string
    flag?: string
    ableFlag?: boolean
}

let charSeq = 0

/** Run `data` through a single editoutput regex script and return the result. */
async function runScript(spec: ScriptSpec, data: string) {
    // A fresh chaId per call keeps the module-level result cache from answering
    // for a different script that happens to share the same input text.
    charSeq += 1
    const char = {
        type: 'character',
        chaId: `test-char-${charSeq}`,
        customscript: [{
            comment: 'test',
            type: 'editoutput',
            in: spec.in,
            out: spec.out,
            flag: spec.flag ?? '',
            ableFlag: spec.ableFlag ?? true,
        }],
    }
    const result = await processScriptFull(char as never, data, 'editoutput')
    return result.data
}

beforeEach(() => {
    resetScriptCache()
    vi.restoreAllMocks()
})

describe('regex script flag handling', () => {
    it('keeps the global flag when whitespace surrounds an action tag', async () => {
        // "<cbs> " strips to " ", which used to trim away to nothing and fall
        // back to 'u' — losing 'g', so only the first panel was replaced.
        expect(await runScript({ in: 'panel', out: 'X', flag: '<cbs> ' }, 'panel and panel'))
            .toBe('X and X')
        expect(await runScript({ in: 'panel', out: 'X', flag: ' <cbs>' }, 'panel and panel'))
            .toBe('X and X')
        expect(await runScript({ in: 'panel', out: 'X', flag: '<cbs> <no_end_nl>' }, 'panel and panel'))
            .toBe('X and X')
    })

    it('replaces every occurrence in a message, spaced tags or not', async () => {
        const spaced = await runScript({ in: '<panel>.*?</panel>', out: 'P', flag: '<cbs> <no_end_nl>' }, 'a<panel>1</panel>b<panel>2</panel>c')
        const unspaced = await runScript({ in: '<panel>.*?</panel>', out: 'P', flag: '<cbs><no_end_nl>' }, 'a<panel>1</panel>b<panel>2</panel>c')
        expect(spaced).toBe('aPbPc')
        expect(unspaced).toBe(spaced)
    })

    it('still applies a pattern that is legal under g but throws under u', async () => {
        // Escaped hyphen and bare brace: both compile with 'g', both are
        // SyntaxErrors under 'u'. With the old fallback the script was dropped.
        expect(await runScript({ in: 'a\\-b', out: 'HIT', flag: '<cbs> ' }, 'x a-b y'))
            .toBe('x HIT y')
        expect(await runScript({ in: 'a{b', out: 'HIT', flag: '<cbs> ' }, 'x a{b y'))
            .toBe('x HIT y')
    })

    it('honours explicitly requested flags and drops unsupported characters', async () => {
        expect(await runScript({ in: 'AB', out: 'x', flag: 'gi' }, 'ab AB'))
            .toBe('x x')
        expect(await runScript({ in: 'AB', out: 'x', flag: ' g i ' }, 'ab AB'))
            .toBe('x x')
        // No custom flag at all: still the documented default.
        expect(await runScript({ in: 'a', out: 'x', flag: '', ableFlag: false }, 'aa'))
            .toBe('xx')
    })

    it('leaves move_top non-global, as the existing workaround intends', async () => {
        // Regression guard for the reordering: normalizing before the move_*
        // adjustment must not hand 'g' back to a script that just had it removed.
        const moved = await runScript({ in: 'x', out: 'Y', flag: '<move_top>' }, 'x x')
        expect(moved).toBe('Y\n x')
    })

    it('logs a pattern that cannot compile instead of dropping it silently', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const data = await runScript({ in: '(', out: 'x', flag: 'g' }, 'untouched (')

        expect(data).toBe('untouched (')
        expect(spy).toHaveBeenCalled()
        const logged = spy.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
        // The message has to carry the pattern, the effective flag and the cause,
        // or it is no better than the silent return it replaced.
        expect(logged).toContain('(')
        expect(logged).toContain('/g')
        expect(logged.toLowerCase()).toContain('regex script')
        expect(logged).toMatch(/SyntaxError|Invalid regular expression/)
    })

    it('does not log for a script that compiles but never matches', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(await runScript({ in: 'nothing-here', out: 'x', flag: 'g' }, 'plain text'))
            .toBe('plain text')
        expect(spy).not.toHaveBeenCalled()
    })
})
