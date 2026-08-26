import { describe, expect, test, vi } from 'vitest'
import type { Chat, character } from '../storage/database.svelte'
import { buildMergedChat, countSharedMergeMessages, mergeCharacterChats } from './chatMerge'
import { projectWikiRebootTurns } from './wikiReboot'

function chat(id: string, overrides: Partial<Chat> = {}): Chat {
    return {
        id, name: id, note: '', localLore: [], fmIndex: -1,
        message: [{ role: 'user', data: `${id}-user`, chatId: `${id}-u` },
            { role: 'char', data: `${id}-answer`, chatId: `${id}-a` }],
        ...overrides,
    }
}
function ids() { let n = 0; return () => `merged-${++n}` }

describe('chat merge', () => {
    test('copies every message in the requested order without changing sources', () => {
        const sources = [chat('second'), chat('first')]
        const before = structuredClone(sources)
        const result = buildMergedChat(sources, ' 합본 ', ids())
        expect(result.name).toBe('합본')
        expect(result.message.map(m => m.data)).toEqual([
            'second-user', 'second-answer', 'first-user', 'first-answer',
        ])
        expect(sources).toEqual(before)
        result.message[0].data = 'changed'
        expect(sources).toEqual(before)
    })

    test('keeps the last chat settings but the first greeting, clearing derived memory state', () => {
        const first = chat('a', { fmIndex: 2, firstMessageDisabled: true })
        const last = chat('b', {
            note: 'last note', localLore: [{ key: 'last lore' } as any],
            scriptstate: { chapter: 3 }, bindedPersona: 'persona', bindedBotPreset: 'preset',
            risuBardWikiGuide: 'guide', folderId: 'hidden-folder',
            hypaV3Data: {} as any, suggestMessages: ['stale'], sdData: 'stale',
        })
        const result = buildMergedChat([first, last], 'merged', ids())
        expect(result).toMatchObject({
            note: 'last note', scriptstate: { chapter: 3 }, bindedPersona: 'persona',
            bindedBotPreset: 'preset', localLore: last.localLore,
            risuBardWikiGuide: 'guide', fmIndex: 2, firstMessageDisabled: true,
        })
        for (const key of ['hypaV3Data', 'suggestMessages', 'sdData', 'folderId', 'risuBardWikiReboot']) {
            expect(result).not.toHaveProperty(key)
        }
        result.scriptstate!.chapter = 9
        expect(last.scriptstate!.chapter).toBe(3)
    })

    test('assigns unique IDs, resets wiki receipts, and remaps bookmarks even for overlapping sources', () => {
        const first = chat('a')
        first.message[1].risubardMemoryConfirmed = true
        first.message[1].risubardCanonicalReceipt = {} as any
        first.message[1].swipes = ['alternate']
        first.bookmarks = ['a-a']
        first.bookmarkNames = { 'a-a': 'Bookmark' }
        const second = { ...structuredClone(first), id: 'b' }
        expect(countSharedMergeMessages([first, second])).toBe(2)
        const result = buildMergedChat([first, second], 'merged', ids())
        expect(new Set([result.id, ...result.message.map(m => m.chatId)]).size).toBe(5)
        expect(result.message).toHaveLength(4)
        expect(result.bookmarks).toEqual([result.message[1].chatId, result.message[3].chatId])
        expect(Object.values(result.bookmarkNames!)).toEqual(['Bookmark', 'Bookmark'])
        for (const message of result.message) {
            expect(message).not.toHaveProperty('risubardMemoryConfirmed')
            expect(message).not.toHaveProperty('risubardCanonicalReceipt')
        }
        expect(result.message[1].swipes).toEqual(['alternate'])
        expect(projectWikiRebootTurns(result.message)).toHaveLength(2)
    })

    test('preserves disabled and comment messages without reviving them in reboot', () => {
        const first = chat('a')
        first.message[1].disabled = true
        const second = chat('b')
        second.message.push({ role: 'char', data: 'comment', isComment: true })
        const result = buildMergedChat([first, second], 'merged', ids())
        expect(result.message).toHaveLength(5)
        expect(projectWikiRebootTurns(result.message).map(t => t.messages.at(-1)?.content)).toEqual(['b-answer'])
    })

    test('limits allBefore exclusions to their original session', () => {
        const first = chat('a')
        const second = chat('b')
        second.message[0].disabled = 'allBefore'
        const result = buildMergedChat([first, second], 'merged', ids())
        expect(result.message.map(message => message.disabled)).toEqual([undefined, undefined, true, undefined])
        expect(projectWikiRebootTurns(result.message).map(t => t.messages.at(-1)?.content)).toEqual(['a-answer', 'b-answer'])
        expect(second.message[0].disabled).toBe('allBefore')
    })

    test.each([
        [chat('a')], [chat('a'), chat('a')],
        [chat('a'), chat('b', { _placeholder: true })],
        [chat('a'), chat('b', { isStreaming: true })],
        [chat('a'), chat('b', { risuBardWikiReboot: { status: 'paused' } as any })],
    ])('rejects incomplete, duplicate, or busy sources %#', (...sources) => {
        expect(() => buildMergedChat(sources, 'merged', ids())).toThrow()
    })

    test('hydrates by stable ID and saves before returning the new chat', async () => {
        const character = { chaId: 'character', chats: [chat('a'), chat('b', { _placeholder: true })], chatPage: 0 } as character
        const hydrate = vi.fn(async (id: string) => chat(id))
        const save = vi.fn(async () => {
            expect(character.chats).toHaveLength(3)
            expect(character.chatPage).toBe(0)
        })
        const result = await mergeCharacterChats(character, ['b', 'a'], 'merged', {
            hydrate, snapshot: structuredClone, save, createId: ids(),
        })
        expect(hydrate.mock.calls.map(c => c[0])).toEqual(['b', 'a'])
        expect(result.message[0].data).toBe('b-user')
        expect(save).toHaveBeenCalledOnce()
        expect(character.chats.at(-1)).toBe(result)
    })

    test('rolls back only the new chat on save failure, retaining the active chat and sources', async () => {
        const character = { chaId: 'character', chats: [chat('a'), chat('b')], chatPage: 1 } as character
        const before = structuredClone(character)
        const save = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce(undefined)
        await expect(mergeCharacterChats(character, ['a', 'b'], 'merged', {
            hydrate: async id => character.chats.find(c => c.id === id)!,
            snapshot: structuredClone, save, createId: ids(),
        })).rejects.toThrow('disk full')
        expect(character).toEqual(before)
        expect(save).toHaveBeenCalledTimes(2)
    })

    test('does not publish a partial merge when loading fails or a source is removed', async () => {
        const character = { chaId: 'character', chats: [chat('a'), chat('b')], chatPage: 0 } as character
        const save = vi.fn()
        await expect(mergeCharacterChats(character, ['a', 'b'], 'merged', {
            hydrate: async id => id === 'a' ? chat('a') : null,
            snapshot: structuredClone, save, createId: ids(),
        })).rejects.toThrow()
        expect(character.chats).toHaveLength(2)
        expect(save).not.toHaveBeenCalled()
    })
})
