/**
 * What the send path actually reads out of `chat.message`.
 *
 * `promptHistoryPreload.ts` has to decide, BEFORE the send, how far back the
 * resident history must reach. Today it decides by token budget
 * (`maxContext`, 65,000 by default), which over-fetches by 2x or more. Any
 * tighter bound has to be derived from the consumers, so these tests pin what
 * the consumers are and how far each one reaches. They assert current
 * behaviour; a change to any of them changes the bound.
 */
import { writable } from 'svelte/store'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

const { mockDBState, mockModuleSources } = vi.hoisted(() => ({
    mockDBState: { db: {} as any },
    mockModuleSources: [] as Array<{ scopeId: string; entry: any }>,
}))

vi.mock('../stores.svelte', () => ({
    DBState: mockDBState,
    selectedCharID: writable(0),
}))
vi.mock('../tokenizer', () => ({ tokenize: vi.fn(async () => 1) }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (value: string) => value }))
vi.mock('../util', () => ({
    findCharacterbyId: vi.fn(),
    pickHashRand: vi.fn(() => 1),
    selectSingleFile: vi.fn(),
}))
vi.mock('../alert', () => ({ alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('../../lang', () => ({ getCurrentLocale: () => 'en', language: {} }))
vi.mock('../globalApi.svelte', () => ({ downloadFile: vi.fn(), saveAsset: vi.fn() }))
vi.mock('./modules', () => ({
    getModuleLorebooks: () => [],
    getModuleLorebooksWithSources: () => mockModuleSources,
}))

import { loadLoreBookV3Prompt } from './lorebook.svelte'
import { selectNarrativeWorkingMessages } from '../risubard/narrativeContext'

function entry(comment: string, key: string, content: string) {
    return {
        comment, key, content,
        mode: 'normal', insertorder: 100, alwaysActive: false,
        secondkey: '', selective: false, useRegex: false,
    }
}

/** `count` messages; only the OLDEST one carries `needle`. */
function historyWithOldNeedle(count: number, needle: string) {
    return Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'char',
        data: index === 0 ? needle : `filler ${index}`,
        chatId: `m${index}`,
    }))
}

function prepare(entries: any[], messages: any[], loreSettings: Record<string, unknown> = {}) {
    mockModuleSources.splice(0, mockModuleSources.length)
    const character = {
        chaId: 'c1', name: 'Char', chatPage: 0,
        globalLore: entries,
        chats: [{ id: 'chat-1', message: messages, localLore: [], scriptstate: {}, fmIndex: -1 }],
        loreSettings: { tokenBudget: 8000, scanDepth: 5, recursiveScanning: false, matchingMode: 'partial', ...loreSettings },
    }
    mockDBState.db = { username: 'user', loreBookDepth: 5, loreBookToken: 8000, characters: [character] }
    return character
}

const activated = (result: { actives: { source: string }[] }) =>
    result.actives.map((active) => active.source).sort()

describe('lorebook scan depth is a per-entry maximum, not one setting', () => {
    it('activates an entry whose own @@scan_depth reaches past the character setting', async () => {
        // 30 messages, needle only in the oldest. Character scanDepth is 5.
        prepare([
            entry('shallow', 'needle', 'A'),
            entry('deep', 'needle', '@@scan_depth 30\nB'),
        ], historyWithOldNeedle(30, 'needle'))

        // The character-level depth of 5 is NOT the bound: `deep` overrode it
        // and reached message 0. A preload that loaded only the newest 5 would
        // have dropped `deep` from the prompt, silently.
        expect(activated(await loadLoreBookV3Prompt())).toEqual(['deep'])
    })

    it('scans the ENTIRE resident array when @@scan_depth does not parse', async () => {
        // `scanDepth = parseInt(arg[0])` has no NaN guard (lorebook.svelte.ts:379),
        // unlike the `depth` decorator right above it. NaN then reaches
        // `messages.slice(messages.length - NaN, length)`, which is `slice(NaN, len)`
        // -- i.e. slice(0, len): the whole array. This is the one entry shape
        // whose reach CANNOT be bounded by any number computed before the send.
        prepare([entry('unparseable', 'needle', '@@scan_depth all\nA')],
            historyWithOldNeedle(200, 'needle'))

        expect(activated(await loadLoreBookV3Prompt())).toEqual(['unparseable'])
    })

    it('counts @@activate_only_after against the resident length when there is no window', async () => {
        // This decorator wants the CONVERSATION's length, which no depth-based
        // preload bound can supply. `lorebook.svelte.ts` now reads the
        // hydration window's `total` and falls back to the resident count only
        // when there is no window -- a legacy full load or a non-SQL backend,
        // which is the case pinned here. The windowed case, where the fix
        // actually matters, is pinned in `promptHistoryBound.test.ts` under
        // "decorators that want the conversation length, not a depth".
        const entries = [entry('late', '', '@@activate_only_after 100\nA')]
        entries[0].alwaysActive = true

        prepare(entries, historyWithOldNeedle(40, 'x'))
        expect(activated(await loadLoreBookV3Prompt())).toEqual([])

        prepare(entries, historyWithOldNeedle(150, 'x'))
        expect(activated(await loadLoreBookV3Prompt())).toEqual(['late'])
    })
})

describe('the narrative working set is what the request actually carries', () => {
    it('keeps only the newest `limit` messages', () => {
        const messages = Array.from({ length: 500 }, (_, index) => ({ role: 'user', data: `${index}` }))
        // Default `risuBardResponseMessageCount` is 12.
        expect(selectNarrativeWorkingMessages(messages, 12)).toHaveLength(12)
        expect(selectNarrativeWorkingMessages(messages, 12)[0].data).toBe('488')
    })

    it('runs in sendChat before the request is built and before every memory mode', () => {
        // A source-order assertion because the ordering IS the finding: the
        // narrowing happens before the `chats` array is filled, so the token
        // budget the preload measures against is never the bound on history --
        // `risuBardResponseMessageCount` is.
        const source = readFileSync(resolve(process.cwd(), 'src/ts/process/index.svelte.ts'), 'utf-8')
        const sendChat = source.indexOf('export async function sendChat(')
        expect(sendChat).toBeGreaterThan(-1)

        const narrowing = source.indexOf('ms = selectNarrativeWorkingMessages(', sendChat)
        const chatsLoop = source.indexOf('for(const msg of ms){', sendChat)
        const hypa = source.indexOf('await hypaMemoryV3(chats,', sendChat)
        const splice = source.indexOf('chats.splice(0, 1)', sendChat)

        expect(narrowing).toBeGreaterThan(-1)
        expect(narrowing).toBeLessThan(chatsLoop)
        expect(chatsLoop).toBeLessThan(hypa)
        expect(chatsLoop).toBeLessThan(splice)
    })
})

describe('consumers that read from the OLDEST end', () => {
    it('seeds additionalInformations from the first four resident messages', () => {
        // `chats.message.slice(0, 4)` -- the oldest end of the RESIDENT slice,
        // not of the conversation. No depth-from-newest bound reaches it; only
        // a full load does. Guarded by `char.additionalText` being non-empty.
        const source = readFileSync(resolve(process.cwd(), 'src/ts/process/embedding/addinfo.ts'), 'utf-8')
        expect(source).toContain('chats.message.slice(0, 4)')
    })
})
