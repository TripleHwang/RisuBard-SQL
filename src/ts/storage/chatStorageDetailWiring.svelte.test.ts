/**
 * `ensureChatHydrated` is the hook that has to fire, not just exist.
 *
 * The chat-detail read is only a fix for the reported bug if the app's chat-open
 * path actually calls it. `ensureChatHydrated` is that path's single choke
 * point -- ChatScreen, SideChatList, characterOpen, chatOpen, characters.ts,
 * jobRecovery and globalApi all funnel through it -- so it is the one place the
 * wiring can be wrong for every caller at once.
 *
 * Two ways it can be wrong, both covered here:
 *
 *  - the `server-sql` branch could load only the message page, which is exactly
 *    what it did before this fix and exactly what the end-to-end suite does NOT
 *    catch, because that suite calls `ensureChatDetailsHydrated` itself;
 *  - the early return could fire first. A chat opened a second time has
 *    `messagesLoaded === true`, so the old `needsSqlWindow`-only condition
 *    returned the slot before anything looked at `detailsLoaded`.
 *
 * `.svelte.test.ts` and a real `$state` array: the slot the settings must land
 * on is a proxy, and a fix that writes to a detached object passes with a plain
 * array.
 */
import { flushSync } from 'svelte'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

import type { Chat } from './database.svelte'

const runtimeState = vi.hoisted(() => ({ database: { characters: [] as any[] } as any }))

// The heavy module graph behind a chat open, stubbed to what this path touches.
// `sqlBootstrap` and `sqlRuntimeHydration` are deliberately REAL: they are the
// wiring under test.
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: { fetchChatContent: async () => null } },
}))
vi.mock('./database.svelte', () => ({
    getDatabase: () => runtimeState.database,
    isChatStub: (chat: any) => chat && chat._stub === true && !Array.isArray(chat.message),
}))
vi.mock('./sql/sqlPersistenceRuntime', () => ({
    flushSqlDirtyChanges: vi.fn(async () => undefined),
    markSqlChatDirty: vi.fn(),
    deactivateSqlPersistenceRuntime: vi.fn(),
}))
vi.mock('../process/generationState', () => ({ isChatGenerating: () => false }))
vi.mock('../stores.svelte', () => ({
    selectedCharID: { subscribe: (run: (value: number) => void) => { run(0); return () => undefined } },
}))
vi.mock('../performance/performanceReport', () => ({ updateRuntimeResources: vi.fn() }))

const { setActiveSqlStorageForTesting } = await import('./sql/sqlBootstrap')
const { getSqlPosition, getSqlWindow } = await import('./sql/sqlRuntimeWindow')
const { ensureChatHydrated } = await import('./chatStorage')

const CHARACTER_ID = 'character-wiring'
const CHAT_ID = 'chat-wiring'

/** The stored settings -- every one of them a `chat_extension_nodes` field. */
const STORED = {
    localLore: [{ key: 'per-chat-lore', content: 'only this chat knows this' }],
    fmIndex: 2,
    bindedPersona: 'persona-from-storage',
    bindedBotPreset: 'preset-from-storage',
    useModelPreset: true,
    modelBinding: { main: 'model-main', sub: 'model-sub' },
}

function detailStorage(overrides: Partial<Record<string, unknown>> = {}) {
    return {
        backendKind: 'server-sql' as const,
        loadChatHydration: vi.fn(async () => ({
            ...STORED,
            id: CHAT_ID,
            name: 'Chat 0',
            note: '',
            message: [],
            detailsLoaded: true,
        } as unknown as Chat)),
        loadChatMessageReversePage: vi.fn(async () => ({
            messages: [{ role: 'char', data: 'greeting', chatId: `${CHAT_ID}-msg-0` }],
            positions: [0],
            before: null,
            nextBefore: null,
            hasMore: false,
            total: 1,
            nextPosition: 1,
        })),
        loadCharacterHydration: vi.fn(),
        loadRootKeyHydration: vi.fn(),
        ...overrides,
    } as any
}

/** What the bootstrap hands the app: four columns and the residency flags. */
function summary(extra: Record<string, unknown> = {}) {
    return {
        id: CHAT_ID,
        name: 'Chat 0',
        note: '',
        message: [],
        messageTotal: 1,
        messagesLoaded: false,
        messagesFullyLoaded: false,
        detailsLoaded: false,
        ...extra,
    } as unknown as Chat
}

beforeEach(() => { setActiveSqlStorageForTesting(null) })
afterEach(() => { setActiveSqlStorageForTesting(null) })

describe('ensureChatHydrated on the server-sql path', () => {
    it("loads the chat's own settings, not only its message page", async () => {
        const storage = detailStorage()
        setActiveSqlStorageForTesting(storage)
        const db = $state({
            characters: [{ chaId: CHARACTER_ID, chatPage: 0, chats: [summary()] }],
        })
        runtimeState.database = db

        const hydrated = await ensureChatHydrated(db.characters[0].chats as Chat[], 0, CHARACTER_ID)
        flushSync()

        expect(storage.loadChatHydration).toHaveBeenCalledWith(CHAT_ID)
        // The live slot, and the settings on it.
        expect(hydrated).toBe(db.characters[0].chats[0])
        expect({
            bindedPersona: hydrated!.bindedPersona,
            bindedBotPreset: hydrated!.bindedBotPreset,
            fmIndex: hydrated!.fmIndex,
            useModelPreset: hydrated!.useModelPreset,
            modelBinding: hydrated!.modelBinding,
            localLoreKey: hydrated!.localLore?.[0]?.key,
            detailsLoaded: (hydrated as Chat & { detailsLoaded?: boolean }).detailsLoaded,
        }).toEqual({
            bindedPersona: 'persona-from-storage',
            bindedBotPreset: 'preset-from-storage',
            fmIndex: 2,
            useModelPreset: true,
            modelBinding: { main: 'model-main', sub: 'model-sub' },
            localLoreKey: 'per-chat-lore',
            detailsLoaded: true,
        })
        // And the message window still arrived, with its canonical position.
        expect(hydrated!.message.map(message => message.chatId)).toEqual([`${CHAT_ID}-msg-0`])
        expect(getSqlPosition(hydrated!.message[0])).toBe(0)
        expect(getSqlWindow(hydrated!)?.total).toBe(1)
    })

    it('still loads the settings when only the messages are already resident', async () => {
        // The second open of a chat. `messagesLoaded` is true, so the old
        // early-return condition was satisfied and the settings were never read.
        const storage = detailStorage()
        setActiveSqlStorageForTesting(storage)
        const db = $state({
            characters: [{
                chaId: CHARACTER_ID,
                chatPage: 0,
                chats: [summary({ messagesLoaded: true, messagesFullyLoaded: true })],
            }],
        })
        runtimeState.database = db

        const hydrated = await ensureChatHydrated(db.characters[0].chats as Chat[], 0, CHARACTER_ID)
        flushSync()

        expect(storage.loadChatHydration).toHaveBeenCalledWith(CHAT_ID)
        expect(hydrated!.bindedPersona).toBe('persona-from-storage')
        expect(hydrated!.fmIndex).toBe(2)
    })

    it('returns immediately once the settings and the window are both in', async () => {
        const storage = detailStorage()
        setActiveSqlStorageForTesting(storage)
        const db = $state({
            characters: [{
                chaId: CHARACTER_ID,
                chatPage: 0,
                chats: [summary({
                    messagesLoaded: true,
                    messagesFullyLoaded: true,
                    detailsLoaded: true,
                })],
            }],
        })
        runtimeState.database = db

        await ensureChatHydrated(db.characters[0].chats as Chat[], 0, CHARACTER_ID)

        expect(storage.loadChatHydration).not.toHaveBeenCalled()
        expect(storage.loadChatMessageReversePage).not.toHaveBeenCalled()
    })

    it('still opens the chat when the settings read fails, and leaves it unloaded', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        const storage = detailStorage({
            loadChatHydration: vi.fn(async () => { throw new Error('the server was unreachable') }),
        })
        setActiveSqlStorageForTesting(storage)
        const db = $state({
            characters: [{ chaId: CHARACTER_ID, chatPage: 0, chats: [summary()] }],
        })
        runtimeState.database = db

        const hydrated = await ensureChatHydrated(db.characters[0].chats as Chat[], 0, CHARACTER_ID)
        flushSync()

        // The conversation still opens...
        expect(hydrated).toBe(db.characters[0].chats[0])
        expect(hydrated!.message.map(message => message.chatId)).toEqual([`${CHAT_ID}-msg-0`])
        // ...but the chat is NOT marked loaded, which is what keeps
        // `buildSqlDirtyCommit` refusing to write the summary over the stored
        // settings.
        expect((hydrated as Chat & { detailsLoaded?: boolean }).detailsLoaded).toBe(false)
        expect(consoleError).toHaveBeenCalled()
        consoleError.mockRestore()
    })
})
