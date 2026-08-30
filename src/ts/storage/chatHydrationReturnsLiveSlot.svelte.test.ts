/**
 * `ensureChatHydrated` must hand back the object that is in the database.
 *
 * This is the second instance of the persistence bug's whole class, and unlike
 * `ensureCharacterHydrated` it had live callers. The function fetched a chat,
 * wrote it into `chats[currentIndex]`, and returned the fetched object. `chats`
 * is a `$state` array, so the slot holds a PROXY of what was written and a
 * Svelte 5 proxy never writes through to its target: the returned object is
 * detached from the database from the instant it is installed.
 *
 * `loadTogglesFromChat` mutates the chat it is given -- it moves
 * `savedToggleValues` into `GLGlobalVariables`, sets
 * `useLocallySetGlobalVariables`, and clears `savedToggleValues`. Two callers
 * (`characters.ts` `selectCharacter` and `globalApi.svelte.ts` `changeChatTo`)
 * pass this return value straight into it. Against a detached object all three
 * writes vanish: the user's toggle values never reach the chat the UI reads,
 * nothing is marked dirty, and `savedToggleValues` is never cleared, so the
 * migration re-runs on every open forever.
 *
 * The array here is a real `$state` array for exactly the reason the bug
 * existed: with a plain array the test passes either way.
 */
import { flushSync } from 'svelte'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { observeReactive } from '../process/request/proxyFixture.svelte'

const fetched = vi.hoisted(() => ({ current: null as any }))
const runtimeState = vi.hoisted(() => ({ database: { characters: [] as any[] } as any }))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        realStorage: {
            fetchChatContent: async () => fetched.current,
        },
    },
}))
vi.mock('./database.svelte', () => ({
    getDatabase: () => runtimeState.database,
    isChatStub: (chat: any) => chat && chat._stub === true && !Array.isArray(chat.message),
}))
// No SQL backend: this is the legacy fetch path, which is the one that
// installs a freshly fetched object into the slot.
vi.mock('./sql/sqlBootstrap', () => ({ getActiveSqlStorage: () => null }))
vi.mock('./sql/sqlPersistenceRuntime', () => ({
    flushSqlDirtyChanges: vi.fn(async () => undefined),
    markSqlChatDirty: vi.fn(),
}))
vi.mock('../process/generationState', () => ({ isChatGenerating: () => false }))
vi.mock('../stores.svelte', () => ({
    selectedCharID: { subscribe: (run: (value: number) => void) => { run(0); return () => undefined } },
}))

const { ensureChatHydrated } = await import('./chatStorage')

const CHAT_ID = 'chat-live-slot'

describe('ensureChatHydrated', () => {
    beforeEach(() => {
        fetched.current = null
    })

    it('returns the live database slot, not the record it installed', async () => {
        const full = {
            id: CHAT_ID,
            name: 'Chat 0',
            note: '',
            localLore: [],
            message: [{ role: 'char', data: 'greeting', chatId: `${CHAT_ID}-msg-0` }],
            savedToggleValues: { toggle_a: '1' },
        } as any
        fetched.current = full

        // A real `$state` graph, as the application holds it.
        const db = $state({
            characters: [{
                chaId: 'character-live-slot',
                chatPage: 0,
                chats: [{ id: CHAT_ID, name: 'Chat 0', note: '', localLore: [], message: [], _placeholder: true }],
            }],
        }) as any
        runtimeState.database = db
        const chats = db.characters[0].chats

        const hydrated = await ensureChatHydrated(chats, 0, 'character-live-slot')

        // The UI and the save change-tracker read the slot reactively. Observe
        // it the way they do, before the write: this is also what makes the
        // failure deterministic. A raw write can appear through the proxy while
        // the property has no source yet, but once anything has read it the
        // shadow is permanent -- and nothing ever re-runs either way.
        const observed = observeReactive(() => (chats[0] as any).useLocallySetGlobalVariables)
        // Flush before the baseline: `$effect.root` schedules the effect rather
        // than running it, so a `runs` read taken here would be its first run,
        // not a re-run, and the write below would look observed either way.
        flushSync()
        const runsBefore = observed.runs
        expect(observed.current).toBeUndefined()

        // What `loadTogglesFromChat` does to the value it is handed.
        hydrated!.GLGlobalVariables = { ...(hydrated as any).savedToggleValues }
        ;(hydrated as any).useLocallySetGlobalVariables = true
        ;(hydrated as any).savedToggleValues = undefined
        flushSync()

        expect({
            observedByTheUi: observed.current,
            reRan: observed.runs > runsBefore,
            globalsInTheDatabase: chats[0].GLGlobalVariables,
            savedToggleValuesCleared: (chats[0] as any).savedToggleValues === undefined,
            returnedTheLiveSlot: hydrated === chats[0],
        }).toEqual({
            observedByTheUi: true,
            reRan: true,
            globalsInTheDatabase: { toggle_a: '1' },
            savedToggleValuesCleared: true,
            returnedTheLiveSlot: true,
        })
        observed.stop()

        expect(hydrated).not.toBe(full)
    })
})
