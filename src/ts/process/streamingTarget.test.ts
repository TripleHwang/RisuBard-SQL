import { describe, expect, test } from 'vitest'
import type { character } from '../storage/database.svelte'
import { findStreamingChat, findStreamingMessageTarget } from './streamingTarget'

describe('findStreamingMessageTarget', () => {
    test('re-finds a streamed message after chats are reordered', () => {
        const first = { id: 'first', message: [{ chatId: 'other', data: '' }] }
        const streamed = { id: 'streamed', message: [{ chatId: 'message', data: '' }] }
        const characters = [{ chaId: 'character', chats: [first, streamed] }]

        characters[0].chats.reverse()
        expect(findStreamingMessageTarget(characters as unknown as character[], 'character', 'streamed', 'message')).toMatchObject({
            chat: streamed,
            index: 0,
        })
    })

    test('returns nothing when the target message was deleted during an await', () => {
        const chat = { id: 'streamed', message: [{ chatId: 'message', data: '' }] }
        const characters = [{ chaId: 'character', chats: [chat] }]
        chat.message.length = 0

        expect(findStreamingMessageTarget(characters as unknown as character[], 'character', 'streamed', 'message')).toBeUndefined()
        expect(findStreamingChat(characters as unknown as character[], 'character', 'streamed')?.chat).toBe(chat)
    })
})
