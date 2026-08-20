import { describe, expect, it } from 'vitest'

const {
    DEFAULT_CHAT_CONTENT_PAGE_SIZE,
    MAX_CHAT_CONTENT_PAGE_SIZE,
    createChatContentPage,
} = require('./chat-content-page.cjs')

describe('createChatContentPage', () => {
    const chat = {
        id: 'chat-1',
        name: 'Long chat',
        note: 'kept as metadata',
        message: Array.from({ length: 25 }, (_, index) => ({ data: `m${index}` })),
    }

    it('returns metadata separately from an exact message slice', () => {
        const page = createChatContentPage(chat, 10, 10)
        expect(page.chat).toEqual({ id: 'chat-1', name: 'Long chat', note: 'kept as metadata' })
        expect(page.messages.map((message: { data: string }) => message.data)).toEqual(
            Array.from({ length: 10 }, (_, index) => `m${index + 10}`),
        )
        expect(page).toMatchObject({ offset: 10, limit: 10, total: 25 })
    })

    it('clamps invalid ranges and does not mutate the source chat', () => {
        const before = structuredClone(chat)
        expect(createChatContentPage(chat, -100, 1)).toMatchObject({
            offset: 0,
            limit: 10,
            total: 25,
        })
        expect(createChatContentPage(chat, 999, 9999)).toMatchObject({
            offset: 25,
            limit: MAX_CHAT_CONTENT_PAGE_SIZE,
            messages: [],
        })
        expect(chat).toEqual(before)
    })

    it('uses a bounded default and supports empty chats', () => {
        expect(createChatContentPage({ id: 'empty', message: [] }, undefined, undefined)).toEqual({
            chat: { id: 'empty' },
            messages: [],
            offset: 0,
            limit: DEFAULT_CHAT_CONTENT_PAGE_SIZE,
            total: 0,
        })
    })
})
