/**
 * How a chat's stored fields are applied to the live slot.
 *
 * Three rules, each of which this codebase has paid for before:
 *
 *  - apply INTO the slot. Replacing it would store a proxy of a rebuilt object
 *    and drop the symbol-keyed hydration window, every canonical message
 *    position and the resident messages themselves;
 *  - never let a failed read read as "this chat has nothing". `detailsLoaded`
 *    becomes `true` only after the fields are actually in, because that flag is
 *    what `buildSqlDirtyCommit` consults before it is allowed to write the chat
 *    back over the stored row;
 *  - never clobber an edit made while the request was in the air.
 *
 * `.svelte.test.ts` so `$state` is a real Svelte 5 proxy. The write-through
 * question is the whole point: a proxy never writes through to its target, so a
 * field written to the raw object instead of the slot is invisible to the
 * application.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Chat } from '../database.svelte'
import type { ISqlStorage } from './ISqlStorage'
import { setActiveSqlStorageForTesting } from './sqlBootstrap'
import { ensureChatDetailsHydrated } from './sqlRuntimeHydration'
import { getSqlPosition, getSqlWindow, setSqlPosition, setSqlWindow } from './sqlRuntimeWindow'

const CHARACTER_ID = 'character-chat-detail'
const CHAT_ID = 'chat-chat-detail'

function storageServing(load: () => Promise<Chat | null>): ISqlStorage {
    return {
        backendKind: 'server-sql' as const,
        loadCharacterHydration: vi.fn(),
        loadChatHydration: vi.fn(load),
        loadChatMessageReversePage: vi.fn(),
        loadRootKeyHydration: vi.fn(),
    } as unknown as ISqlStorage
}

/** What the bootstrap gives us: four columns and the residency bookkeeping. */
function summarySlot(): Chat {
    return {
        id: CHAT_ID,
        name: 'Chat 0',
        note: 'the note',
        message: [],
        messageTotal: 3,
        messagesLoaded: false,
        messagesFullyLoaded: false,
        detailsLoaded: false,
    } as unknown as Chat
}

/** What `GET /api/sql/chats/:chatId` returns: nodes, decorated with the summary. */
function storedChat(extra: Record<string, unknown> = {}): Chat {
    return {
        localLore: [{ key: 'per-chat-lore' }],
        fmIndex: 2,
        bindedPersona: 'persona-from-storage',
        ...extra,
        id: CHAT_ID,
        name: 'Chat 0',
        note: 'the note',
        message: [],
        messageTotal: 3,
        messagesLoaded: false,
        messagesFullyLoaded: false,
        detailsLoaded: true,
    } as unknown as Chat
}

beforeEach(() => { setActiveSqlStorageForTesting(null) })
afterEach(() => { setActiveSqlStorageForTesting(null) })

describe('ensureChatDetailsHydrated', () => {
    it('applies the stored fields into the live slot and returns it', async () => {
        setActiveSqlStorageForTesting(storageServing(async () => storedChat()))
        const chats = $state([summarySlot()])

        const hydrated = await ensureChatDetailsHydrated(chats, 0, CHARACTER_ID)

        expect(hydrated).toBe(chats[0])
        expect(hydrated!.bindedPersona).toBe('persona-from-storage')
        expect(hydrated!.fmIndex).toBe(2)
        expect(hydrated!.localLore?.[0]?.key).toBe('per-chat-lore')
        expect((hydrated as Chat & { detailsLoaded?: boolean }).detailsLoaded).toBe(true)
    })

    it('keeps the resident messages, the window and the canonical positions', async () => {
        setActiveSqlStorageForTesting(storageServing(async () => storedChat()))
        const slot = summarySlot()
        slot.message = [{ role: 'char', data: 'resident', chatId: 'm-9' } as never]
        const chats = $state([slot])
        // Marks go on the LIVE object; a mark written to the raw one before the
        // `$state` wrap can be pinned out of existence by the proxy's get trap.
        setSqlPosition(chats[0].message[0], 9)
        setSqlWindow(chats[0], {
            before: null, nextBefore: 4, total: 10,
            hasOlder: true, hasNewer: false, nextAfter: null, nextPosition: 10,
        })

        await ensureChatDetailsHydrated(chats, 0, CHARACTER_ID)

        expect(chats[0].message.map(message => message.chatId)).toEqual(['m-9'])
        expect(getSqlPosition(chats[0].message[0])).toBe(9)
        expect(getSqlWindow(chats[0])?.nextBefore).toBe(4)
        expect(chats[0].bindedPersona).toBe('persona-from-storage')
    })

    it('does not clobber a field the user changed while the request was in the air', async () => {
        let release: (chat: Chat) => void
        const pending = new Promise<Chat>(resolve => { release = resolve })
        setActiveSqlStorageForTesting(storageServing(() => pending))
        const chats = $state([summarySlot()])

        const hydration = ensureChatDetailsHydrated(chats, 0, CHARACTER_ID)
        // The user picks a persona before the response lands. A summary owns
        // none of these keys, so an own key here is a local edit by definition.
        chats[0].bindedPersona = 'persona-the-user-just-picked'
        release!(storedChat())
        await hydration

        expect(chats[0].bindedPersona).toBe('persona-the-user-just-picked')
        // Untouched fields still arrive.
        expect(chats[0].fmIndex).toBe(2)
    })

    it('marks a chat with no stored settings as loaded, not as failed', async () => {
        // A brand-new chat whose row exists and whose node set is genuinely
        // empty. Successfully read, nothing to apply, safe to write back.
        setActiveSqlStorageForTesting(storageServing(async () => ({
            id: CHAT_ID, name: 'Chat 0', note: '', message: [], detailsLoaded: true,
        } as unknown as Chat)))
        const chats = $state([summarySlot()])

        await ensureChatDetailsHydrated(chats, 0, CHARACTER_ID)

        expect((chats[0] as Chat & { detailsLoaded?: boolean }).detailsLoaded).toBe(true)
        expect(chats[0].bindedPersona).toBeUndefined()
    })

    it('leaves a chat the server does not have marked unloaded', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
        setActiveSqlStorageForTesting(storageServing(async () => null))
        const chats = $state([summarySlot()])

        await ensureChatDetailsHydrated(chats, 0, CHARACTER_ID)

        expect((chats[0] as Chat & { detailsLoaded?: boolean }).detailsLoaded).toBe(false)
        expect(consoleError).toHaveBeenCalled()
        consoleError.mockRestore()
    })

    it('leaves a chat whose read threw marked unloaded', async () => {
        setActiveSqlStorageForTesting(storageServing(async () => {
            throw new Error('the server was unreachable')
        }))
        const chats = $state([summarySlot()])

        await expect(ensureChatDetailsHydrated(chats, 0, CHARACTER_ID)).rejects.toThrow(
            'the server was unreachable',
        )
        expect((chats[0] as Chat & { detailsLoaded?: boolean }).detailsLoaded).toBe(false)
    })

    it('does nothing to a chat that was never a summary', async () => {
        const load = vi.fn(async () => storedChat())
        setActiveSqlStorageForTesting(storageServing(load))
        // A chat created in this session has no `detailsLoaded` key at all and
        // is already its own complete record.
        const chats = $state([{
            id: CHAT_ID, name: 'New chat', note: '', message: [], localLore: [],
        } as unknown as Chat])

        expect(await ensureChatDetailsHydrated(chats, 0, CHARACTER_ID)).toBe(chats[0])
        expect(load).not.toHaveBeenCalled()
    })

    it('never re-applies the summary columns over a rename made meanwhile', async () => {
        let release: (chat: Chat) => void
        const pending = new Promise<Chat>(resolve => { release = resolve })
        setActiveSqlStorageForTesting(storageServing(() => pending))
        const chats = $state([summarySlot()])

        const hydration = ensureChatDetailsHydrated(chats, 0, CHARACTER_ID)
        chats[0].name = 'renamed while loading'
        release!(storedChat())
        await hydration

        expect(chats[0].name).toBe('renamed while loading')
    })
})
