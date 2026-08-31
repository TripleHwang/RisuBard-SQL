import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writable } from 'svelte/store'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The preload's target, and the two ways a target that is too tight shows up.
 *
 * Before this change the prompt-history preload walked back until the resident
 * history was worth the WHOLE request budget -- 65,000 tokens on a ModelPreset
 * -- which put a measured 1200-message chat at 740 resident, 2.3x
 * `MAX_RESIDENT_MESSAGES`, to build a prompt whose history is capped at twelve
 * messages by `selectNarrativeWorkingMessages`. `resolvePromptHistoryBound`
 * replaces that with a figure derived from the consumers.
 *
 * A bound that is too generous costs memory. A bound that is too tight costs
 * correctness, invisibly -- a prompt built from a history shorter than it
 * should be, sent with nothing to say so. So the two tests that matter most
 * here are the ones that would catch a target set too low, and both are driven
 * against the REAL consumers rather than a stub of them:
 *
 *  - a lorebook entry carrying `@@scan_depth 150` is run through the real
 *    `loadLoreBookV3Prompt`, with the real decorator parser and the real
 *    `messages.slice(len - scanDepth, len)`, and must still find its key;
 *  - a raised `risuBardResponseMessageCount` is run through the real
 *    `selectNarrativeWorkingMessages`, the function `sendChat` itself calls at
 *    `index.svelte.ts:1953`, and must still come away with a full working set.
 *
 * Both fail if the target ignores the term they cover; both are shown failing
 * at the old opening-page window of 40 in the same test, so the assertion is
 * not vacuously true.
 */

const { mockDBState, mockModuleSources } = vi.hoisted(() => ({
    mockDBState: { db: {} as any },
    mockModuleSources: [] as Array<{ scopeId: string; entry: any }>,
}))

// The peripheral modules `lorebook.svelte.ts` reaches for. The lorebook itself,
// its decorator parsing and its history slice are the real ones -- those are
// what this file is testing.
vi.mock('../stores.svelte', () => ({
    DBState: mockDBState,
    selectedCharID: writable(0),
}))
vi.mock('../tokenizer', () => ({
    tokenize: vi.fn(async (text: string) => Math.ceil(String(text).length / 4)),
}))
vi.mock('../parser/parser.svelte', () => ({
    risuChatParser: (value: string) => value,
}))
vi.mock('../util', () => ({
    findCharacterbyId: vi.fn(),
    pickHashRand: vi.fn(() => 1),
    selectSingleFile: vi.fn(),
}))
vi.mock('../alert', () => ({
    alertError: vi.fn(),
    notifySuccess: vi.fn(),
}))
vi.mock('../../lang', () => ({
    getCurrentLocale: () => 'en',
    language: {},
}))
vi.mock('../globalApi.svelte', () => ({
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}))
vi.mock('./modules', () => ({
    getModuleLorebooks: () => mockModuleSources.map((source) => source.entry),
    getModuleLorebooksWithSources: () => mockModuleSources,
}))

import {
    PROMPT_HISTORY_CEILING_MESSAGES,
    PROMPT_HISTORY_FLOOR_MESSAGES,
    resolvePromptHistoryBound,
} from './promptHistoryBound'
import { loadLoreBookV3Prompt } from './lorebook.svelte'
import {
    normalizeNarrativeWorkingMessageLimit,
    selectNarrativeWorkingMessages,
} from '../risubard/narrativeContext'
import { resolveRisuBardChatSettings } from '../risubard/risuBardSettings'
import { setSqlWindow } from '../storage/sql/sqlRuntimeWindow'

const HISTORY_LENGTH = 1_200
const NEEDLE = 'brackwater'

function lore(comment: string, key: string, content: string, extra: Record<string, unknown> = {}) {
    return {
        comment,
        key,
        content,
        mode: 'normal',
        insertorder: 100,
        alwaysActive: false,
        secondkey: '',
        selective: false,
        useRegex: false,
        ...extra,
    } as any
}

/**
 * A conversation of `HISTORY_LENGTH` messages with one distinctive word placed
 * exactly `needleFromEnd` messages from the newest end, alternating user/char
 * the way a real chat does.
 */
function history(needleFromEnd: number): any[] {
    return Array.from({ length: HISTORY_LENGTH }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'char',
        data: index === HISTORY_LENGTH - needleFromEnd
            ? `we finally reached ${NEEDLE} at dusk`
            : `ordinary message number ${index}`,
        chatId: `msg-${String(index).padStart(4, '0')}`,
    }))
}

/** What a chat holds after the preload has loaded `resident` messages. */
function newest(messages: any[], resident: number): any[] {
    return messages.slice(Math.max(0, messages.length - resident))
}

function makeCharacter(options: {
    globalLore?: any[]
    resident: any[]
    loreScanDepth?: number
    risuBardSettings?: Record<string, unknown>
}) {
    return {
        chaId: 'char-bound',
        type: 'character',
        name: 'Ada',
        chatPage: 0,
        globalLore: options.globalLore ?? [],
        loreSettings: options.loreScanDepth === undefined
            ? undefined
            : { scanDepth: options.loreScanDepth, recursiveScanning: false, maxRecursionSteps: 1 },
        chats: [{
            id: 'chat-bound',
            name: 'Chat 0',
            note: '',
            localLore: [],
            fmIndex: -1,
            message: options.resident,
            ...(options.risuBardSettings ? { risuBardSettings: options.risuBardSettings } : {}),
        }],
    } as any
}

function baseDatabase(overrides: Record<string, unknown> = {}) {
    return {
        username: 'reporter',
        loreBookDepth: 5,
        loreBookToken: 4_000,
        maxContext: 4_000,
        ...overrides,
    } as any
}

beforeEach(() => {
    mockModuleSources.splice(0, mockModuleSources.length)
})

describe('how far back a send has to load', () => {
    it('asks for the opening page and nothing more at default settings', () => {
        const character = makeCharacter({ resident: [] })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())

        // Every term at its default: a twelve-message narrative working set, a
        // twelve-message recent-memory projection, a scan depth of five, a
        // three-message confirmed turn. All of them fit inside the page a chat
        // already opens on, so the honest answer is "load nothing".
        expect(bound.targetMessages).toBe(PROMPT_HISTORY_FLOOR_MESSAGES)
        expect(bound.unboundedReason).toBeUndefined()
        expect(bound.terms.map((term) => term.messages)).toEqual([12, 12, 5, 4])
        // What the prompt must be able to SEE, separately from how many array
        // slots that is guessed to take.
        expect(bound.targetEnabledMessages).toBe(12)
        expect(bound.residentCeiling).toBe(PROMPT_HISTORY_CEILING_MESSAGES)
    })

    it('keeps the visible requirement separate from the guess at its raw cost', () => {
        // `targetMessages` is `enabled x 2 + 8`, a guess made without reading a
        // single message. On a chat with two of every three recent messages
        // disabled it is short by a third, so the visible figure travels with
        // it and the preload checks the guess against what it actually holds.
        // Measured before this pair existed: 43 visible where 60 were asked for.
        const character = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 60 },
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        expect(bound.targetEnabledMessages).toBe(60)
        expect(bound.targetMessages).toBe(128)

        const history = Array.from({ length: 400 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'char',
            data: `m${index}`,
            ...(index % 3 !== 0 ? { disabled: true } : {}),
        }))
        const atGuess = history.slice(history.length - bound.targetMessages!)
        expect(atGuess.filter((message) => message.disabled !== true).length)
            .toBeLessThan(bound.targetEnabledMessages!)
    })

    it('never asks to see more than the residency bound can hold', () => {
        // A visible target the ceiling cannot satisfy must not become an
        // unbounded walk; the ceiling is the answer.
        const character = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 5_000 },
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        expect(bound.targetEnabledMessages).toBe(PROMPT_HISTORY_CEILING_MESSAGES)
        expect(bound.residentCeiling).toBe(PROMPT_HISTORY_CEILING_MESSAGES)
    })

    it('never asks for less than the window a chat opens on', () => {
        // The floor is what stops this change being a silent loss. Consumers
        // that cannot be bounded before the send -- a trigger script indexing
        // message 30, `{{history}}` inside a lorebook entry -- got 40 messages
        // before the preload existed, and must not get fewer now.
        const character = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 1, risuBardRecentMessageCount: 1 },
        })
        const bound = resolvePromptHistoryBound(
            character,
            character.chats[0],
            baseDatabase({ loreBookDepth: 1 }),
        )
        expect(bound.targetMessages).toBe(PROMPT_HISTORY_FLOOR_MESSAGES)
    })

    it('never asks for more than the residency bound allows', () => {
        const character = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 5_000 },
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        expect(bound.targetMessages).toBe(PROMPT_HISTORY_CEILING_MESSAGES)
    })

    it('doubles the reach when user messages are filtered out of the working set', () => {
        // `selectNarrativeWorkingMessages` drops user messages BEFORE it slices,
        // so `limit` survivors can need up to `2 x limit` raw messages in an
        // alternating history.
        const includingCharacter = makeCharacter({
            resident: [],
            risuBardSettings: { risuBardResponseMessageCount: 60 },
        })
        const including = resolvePromptHistoryBound(
            includingCharacter,
            includingCharacter.chats[0],
            baseDatabase(),
        )
        const excludingCharacter = makeCharacter({
            resident: [],
            risuBardSettings: {
                risuBardResponseMessageCount: 60,
                risuBardResponseExcludeUserMessages: true,
            },
        })
        const excluding = resolvePromptHistoryBound(
            excludingCharacter,
            excludingCharacter.chats[0],
            baseDatabase(),
        )
        expect(including.terms[0].messages).toBe(60)
        expect(excluding.terms[0].messages).toBe(120)
        expect(excluding.targetMessages!).toBeGreaterThan(including.targetMessages!)
    })

    it('reads the deepest scan any activatable entry asks for, not one global setting', () => {
        const character = makeCharacter({
            resident: [],
            loreScanDepth: 20,
            globalLore: [
                lore('shallow', 'anything', 'plain entry'),
                lore('deep', NEEDLE, `@@scan_depth 150\nthe deep entry`),
                lore('disabled but deep', NEEDLE, '@@scan_depth 900\nnever runs', { enabled: false }),
            ],
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        // The 150 counts; the 900 on a disabled entry does not, because a
        // disabled entry never reaches the scan.
        expect(bound.targetMessages).toBe(150)
    })

    it('reads module lorebooks too, which the same scan loads', () => {
        mockModuleSources.push({
            scopeId: 'module:deep',
            entry: lore('module deep', 'anything', '@@scan_depth 200\nmodule entry'),
        })
        const character = makeCharacter({ resident: [] })
        const bound = resolvePromptHistoryBound(
            character,
            character.chats[0],
            baseDatabase(),
            () => mockModuleSources,
        )
        expect(bound.targetMessages).toBe(200)

        // Left out, the module's 200 is invisible and the target is short. That
        // is why `sendChat` handing the getter over is asserted from source
        // below rather than assumed.
        expect(resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
            .targetMessages).toBe(PROMPT_HISTORY_FLOOR_MESSAGES)
    })

    it('refuses to invent a number for a scan depth that does not parse', () => {
        // `lorebook.svelte.ts:379` is `scanDepth = parseInt(arg[0])` with no NaN
        // guard -- unlike the `depth` case directly above it -- and
        // `slice(len - NaN, len)` is `slice(0, len)`, the whole resident array.
        // An entry written that way is asking for everything, so the bound
        // stands aside and lets the token budget be the only stop, which is
        // exactly what every send did before this change.
        const character = makeCharacter({
            resident: [],
            globalLore: [lore('all', NEEDLE, '@@scan_depth all\nthe whole thing')],
        })
        const bound = resolvePromptHistoryBound(character, character.chats[0], baseDatabase())
        expect(bound.targetMessages).toBeUndefined()
        // Nothing is bounded, so the visible figure has nothing to extend.
        expect(bound.targetEnabledMessages).toBeUndefined()
        expect(bound.unboundedReason).toContain('scan_depth')
    })
})

describe('a target too tight to serve the consumers', () => {
    it('still lets a deep @@scan_depth entry find its key, through the real lorebook', async () => {
        const messages = history(150)
        const globalLore = [lore('deep', NEEDLE, '@@scan_depth 150\nTHE DEEP LORE FIRED')]

        // The bound, computed the way `sendChat` computes it, before anything
        // is loaded.
        const planning = makeCharacter({ resident: [], globalLore, loreScanDepth: 5 })
        const bound = resolvePromptHistoryBound(planning, planning.chats[0], baseDatabase())
        expect(bound.targetMessages).toBe(150)

        // The chat as it stands once the preload has loaded that many. This is
        // the real `loadLoreBookV3Prompt`: the real decorator parser sets
        // `scanDepth`, and the real `messages.slice(len - scanDepth, len)` does
        // the scanning.
        const loaded = makeCharacter({
            resident: newest(messages, bound.targetMessages!),
            globalLore,
            loreScanDepth: 5,
        })
        mockDBState.db = baseDatabase({ characters: [loaded] })
        const activated = await loadLoreBookV3Prompt()
        expect(activated.actives.map((active) => active.prompt).join('\n'))
            .toContain('THE DEEP LORE FIRED')

        // ...and would NOT have, on the window a chat opens with. Without this
        // the assertion above could pass for the wrong reason.
        const openingPage = makeCharacter({
            resident: newest(messages, PROMPT_HISTORY_FLOOR_MESSAGES),
            globalLore,
            loreScanDepth: 5,
        })
        mockDBState.db = baseDatabase({ characters: [openingPage] })
        const missed = await loadLoreBookV3Prompt()
        expect(missed.actives.map((active) => active.prompt).join('\n'))
            .not.toContain('THE DEEP LORE FIRED')
    })

    it('still fills a raised risuBardResponseMessageCount, through the real narrowing', () => {
        const risuBardSettings = { risuBardResponseMessageCount: 100 }
        const messages = history(1)

        const planning = makeCharacter({ resident: [], risuBardSettings })
        const bound = resolvePromptHistoryBound(planning, planning.chats[0], baseDatabase())
        expect(bound.targetMessages!).toBeGreaterThanOrEqual(100)

        // `selectNarrativeWorkingMessages` is the function `sendChat` calls at
        // `index.svelte.ts:1953`, on the enabled messages of `chat.message`. A
        // preload that stopped short here would hand it fewer messages than the
        // reader configured and nothing downstream would say so.
        const loaded = newest(messages, bound.targetMessages!)
        expect(selectNarrativeWorkingMessages(loaded, 100, true)).toHaveLength(100)

        // Short by 60 on the window a chat opens with.
        const openingPage = newest(messages, PROMPT_HISTORY_FLOOR_MESSAGES)
        expect(selectNarrativeWorkingMessages(openingPage, 100, true)).toHaveLength(
            PROMPT_HISTORY_FLOOR_MESSAGES,
        )
    })

    it('fills it even when the working set excludes user messages', () => {
        const risuBardSettings = {
            risuBardResponseMessageCount: 60,
            risuBardResponseExcludeUserMessages: true,
        }
        const messages = history(1)
        const planning = makeCharacter({ resident: [], risuBardSettings })
        const bound = resolvePromptHistoryBound(planning, planning.chats[0], baseDatabase())

        // 60 surviving messages out of a strictly alternating history needs 120
        // raw ones; the doubling in the bound is what pays for that.
        const loaded = newest(messages, bound.targetMessages!)
        const selected = selectNarrativeWorkingMessages(loaded, 60, false)
        expect(selected.length).toBeGreaterThanOrEqual(60)
    })
})

/**
 * The comparison the bound has to survive: not "does it match what the bound
 * expects" but "does the prompt still contain what a FULLY RESIDENT history
 * would have put in it".
 *
 * For each configuration this builds the two things that decide the prompt's
 * history -- the lorebook entries that activate, and the narrative working set
 * `sendChat` hands to the request -- at the resident count the bound produces
 * and at full residency, and requires them to be identical. Both are the real
 * functions; `makeMs` is the only thing reproduced here, because it is a
 * closure inside `sendChat`.
 */
describe('the same prompt history a fully resident chat would have built', () => {
    /** `index.svelte.ts:1905`, which is not exported. */
    function makeMs(messages: any[]): any[] {
        const mss: any[] = []
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index]
            if (message.disabled === true) continue
            if (message.disabled === 'allBefore') break
            mss.unshift(message)
        }
        return mss
    }

    const DEEP = 'deepwater'

    /** `HISTORY_LENGTH` messages, one needle 150 back and one 260 back. */
    function conversation(disabledEvery?: number): any[] {
        return Array.from({ length: HISTORY_LENGTH }, (_, index) => ({
            role: index % 2 === 0 ? 'user' : 'char',
            data: index === HISTORY_LENGTH - 150
                ? `we finally reached ${NEEDLE} at dusk`
                : index === HISTORY_LENGTH - 260
                    ? `the ${DEEP} signal was heard`
                    : `ordinary message number ${index}`,
            chatId: `m${String(index).padStart(4, '0')}`,
            // The newest four are always visible so the turn projections have
            // something to read.
            ...(disabledEvery && index % disabledEvery !== 0 && index < HISTORY_LENGTH - 4
                ? { disabled: true }
                : {}),
        }))
    }

    function windowed(char: any, resident: any[]) {
        char.chats[0].message = resident
        setSqlWindow(char.chats[0], {
            before: null,
            nextBefore: 0,
            total: HISTORY_LENGTH,
            hasOlder: resident.length < HISTORY_LENGTH,
            hasNewer: false,
            nextAfter: null,
            nextPosition: HISTORY_LENGTH,
        })
        return char
    }

    async function activeComments(char: any) {
        mockDBState.db = baseDatabase({ characters: [char] })
        const result = await loadLoreBookV3Prompt()
        return result.actives.map((active: any) => active.comment ?? active.source).sort()
    }

    async function compare(options: {
        globalLore?: any[]
        localLore?: any[]
        moduleLore?: any[]
        loreScanDepth?: number
        risuBardSettings?: Record<string, unknown>
        disabledEvery?: number
    }) {
        mockModuleSources.splice(0, mockModuleSources.length)
        for (const entry of options.moduleLore ?? []) {
            mockModuleSources.push({ scopeId: 'module:m', entry })
        }
        const build = (resident: any[]) => {
            const char = makeCharacter({
                resident,
                globalLore: options.globalLore,
                loreScanDepth: options.loreScanDepth,
                risuBardSettings: options.risuBardSettings,
            })
            char.chats[0].localLore = options.localLore ?? []
            return windowed(char, resident)
        }

        const messages = conversation(options.disabledEvery)
        const bound = resolvePromptHistoryBound(
            build([]), build([]).chats[0], baseDatabase(), () => mockModuleSources,
        )
        expect(bound.targetMessages).toBeTypeOf('number')

        // The preload's stop rule, reproduced: the raw target, then as much
        // further as the visible target needs, and never past the ceiling.
        let resident = bound.targetMessages!
        while (
            resident < bound.residentCeiling
            && resident < HISTORY_LENGTH
            && makeMs(newest(messages, resident)).length < (bound.targetEnabledMessages ?? 0)
        ) resident += 1

        const atBound = build(newest(messages, resident))
        const full = build(messages.slice())

        expect(await activeComments(atBound)).toEqual(await activeComments(full))

        const settings = resolveRisuBardChatSettings(
            baseDatabase(), options.risuBardSettings as any,
        )
        const limit = normalizeNarrativeWorkingMessageLimit(settings.risuBardResponseMessageCount)
        const include = !settings.risuBardResponseExcludeUserMessages
        const workingSet = (char: any) =>
            selectNarrativeWorkingMessages(makeMs(char.chats[0].message), limit, include)
                .map((message: any) => message.chatId)
        expect(workingSet(atBound)).toEqual(workingSet(full))
        return { resident, actives: await activeComments(atBound) }
    }

    it('at default settings', async () => {
        expect((await compare({})).resident).toBe(PROMPT_HISTORY_FLOOR_MESSAGES)
    })

    it('with a character scan depth of 20 and an entry at @@scan_depth 150', async () => {
        const result = await compare({
            loreScanDepth: 20,
            globalLore: [
                lore('deep', NEEDLE, '@@scan_depth 150\nDEEP'),
                lore('shallow', `ordinary message number ${HISTORY_LENGTH - 1}`, 'SHALLOW'),
            ],
        })
        expect(result.resident).toBe(150)
        expect(result.actives).toEqual(['deep', 'shallow'])
    })

    it('with the deep entry in the CHAT-LOCAL lorebook', async () => {
        const result = await compare({
            localLore: [lore('localdeep', DEEP, '@@scan_depth 260\nLOCAL')],
        })
        expect(result.resident).toBe(260)
        expect(result.actives).toEqual(['localdeep'])
    })

    it('with the deep entry in a MODULE lorebook', async () => {
        const result = await compare({
            moduleLore: [lore('moduledeep', DEEP, '@@scan_depth 260\nMODULE')],
        })
        expect(result.resident).toBe(260)
        expect(result.actives).toEqual(['moduledeep'])
    })

    it('with a working set of 100', async () => {
        expect((await compare({
            risuBardSettings: { risuBardResponseMessageCount: 100 },
        })).resident).toBe(208)
    })

    it('with a working set of 100 that excludes user messages', async () => {
        await compare({
            risuBardSettings: {
                risuBardResponseMessageCount: 100,
                risuBardResponseExcludeUserMessages: true,
            },
        })
    })

    it('with a recent-memory projection of 80', async () => {
        await compare({ risuBardSettings: { risuBardRecentMessageCount: 80 } })
    })

    it('with two of every three recent messages disabled', async () => {
        // The case the raw target alone gets wrong: 128 slots hold 43 visible
        // messages, not 60. Only the visible target closes it.
        const result = await compare({
            disabledEvery: 3,
            risuBardSettings: { risuBardResponseMessageCount: 60 },
        })
        expect(result.resident).toBeGreaterThan(128)
        expect(result.resident).toBeLessThanOrEqual(PROMPT_HISTORY_CEILING_MESSAGES)
    })

    it('with three of every four recent messages disabled', async () => {
        await compare({
            disabledEvery: 4,
            risuBardSettings: { risuBardResponseMessageCount: 30 },
        })
    })
})

describe('decorators that want the conversation length, not a depth', () => {
    /**
     * `@@activate_only_after N` asks "are we N messages into this conversation
     * yet?" and the lorebook used to answer with `currentChat.length` -- the
     * RESIDENT slice. So the same entry fired or did not depending on how far
     * the reader had scrolled, and on how far the preload had walked. Nothing
     * the preload can load fixes that; the count it needs is the persisted
     * total, which the hydration window knows.
     *
     * This is the one thing tightening the preload's bound would otherwise have
     * made measurably worse -- at 740 accidental resident messages the entry
     * fired, at 40 it would have stopped -- so it is fixed here rather than
     * left to be discovered as a silent behaviour change.
     */
    async function activatesAfter100(resident: number, total: number | null) {
        const messages = history(1)
        const character = makeCharacter({
            resident: newest(messages, resident),
            globalLore: [lore('late', NEEDLE, '@@activate_only_after 100\nLATE LORE FIRED', {
                alwaysActive: true,
            })],
        })
        if (total !== null) {
            setSqlWindow(character.chats[0], {
                before: null,
                nextBefore: 0,
                total,
                hasOlder: resident < total,
                hasNewer: false,
                nextAfter: null,
                nextPosition: total,
            })
        }
        mockDBState.db = baseDatabase({ characters: [character] })
        const activated = await loadLoreBookV3Prompt()
        return activated.actives.map((active) => active.prompt).join('\n')
    }

    it('fires on a long conversation even when only its opening page is resident', async () => {
        expect(await activatesAfter100(PROMPT_HISTORY_FLOOR_MESSAGES, 1_200))
            .toContain('LATE LORE FIRED')
    })

    it('still does not fire on a conversation that really is short', async () => {
        expect(await activatesAfter100(20, 20)).not.toContain('LATE LORE FIRED')
    })

    it('falls back to the resident slice for a chat that was never windowed', async () => {
        // A legacy full load or a non-SQL backend: there is no window to
        // consult and `chat.message` IS the history.
        expect(await activatesAfter100(150, null)).toContain('LATE LORE FIRED')
        expect(await activatesAfter100(20, null)).not.toContain('LATE LORE FIRED')
    })
})

describe('sendChat passes the derived bound to the preload', () => {
    const source = readFileSync(
        resolve(process.cwd(), 'src/ts/process/index.svelte.ts'),
        'utf8',
    )
    const sendChatStart = source.indexOf('export async function sendChat(')

    it('computes the bound before the preload and hands it over', () => {
        const boundCall = source.indexOf('resolvePromptHistoryBound(', sendChatStart)
        const preloadCall = source.indexOf('await ensurePromptHistoryResident(', sendChatStart)
        expect(boundCall).toBeGreaterThan(sendChatStart)
        expect(preloadCall).toBeGreaterThan(boundCall)
        expect(source.slice(preloadCall, preloadCall + 1_800))
            .toContain('targetMessages: historyBound.targetMessages')
    })

    it('hands over the visible target and the ceiling, not just the raw guess', () => {
        // Passing `targetMessages` alone is the shape that loads short on a
        // heavily disabled history, so the other two travelling with it is
        // asserted rather than assumed.
        const preloadCall = source.indexOf('await ensurePromptHistoryResident(', sendChatStart)
        const call = source.slice(preloadCall, preloadCall + 1_800)
        expect(call).toContain('targetEnabledMessages: historyBound.targetEnabledMessages')
        expect(call).toContain('residentCeiling: historyBound.residentCeiling')
    })

    it('hands the module lorebooks over, since the bound cannot import them', () => {
        const boundCall = source.indexOf('resolvePromptHistoryBound(', sendChatStart)
        expect(source.slice(boundCall, boundCall + 400))
            .toContain('getModuleLorebooksWithSources')
    })

    it('keeps the token budget as a ceiling rather than dropping it', () => {
        const preloadCall = source.indexOf('await ensurePromptHistoryResident(', sendChatStart)
        expect(source.slice(preloadCall, preloadCall + 1_200))
            .toContain('budgetTokens: resolvePromptContextBudget(selectedConversation).maxContextTokens')
    })

    it('still narrows the prompt history with the limit the bound is derived from', () => {
        // If this ever stops being the cap on prompt history, the first term of
        // the bound stops being the right term and this file is what should
        // fail.
        expect(source).toContain('ms = selectNarrativeWorkingMessages(')
        expect(source).toContain('resolvedRisuBardSettings(currentChat).risuBardResponseMessageCount')
    })
})
