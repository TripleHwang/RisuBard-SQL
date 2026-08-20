import { describe, expect, it } from 'vitest'
import {
    DEFAULT_CHAT_PAGE_SIZE,
    MAX_CHAT_PAGE_SIZE,
    MIN_CHAT_PAGE_SIZE,
    getChatPageBounds,
    getChatPageCount,
    getChatPageForMessage,
    getLatestChatPage,
    normalizeChatPageSize,
} from './chatPagination'

describe('normalizeChatPageSize', () => {
    it('normalizes finite values into the supported range', () => {
        expect(normalizeChatPageSize(42.9)).toBe(42)
        expect(normalizeChatPageSize(MIN_CHAT_PAGE_SIZE - 1)).toBe(MIN_CHAT_PAGE_SIZE)
        expect(normalizeChatPageSize(MAX_CHAT_PAGE_SIZE + 1)).toBe(MAX_CHAT_PAGE_SIZE)
    })

    it('uses the safe default for invalid values', () => {
        expect(normalizeChatPageSize(undefined)).toBe(DEFAULT_CHAT_PAGE_SIZE)
        expect(normalizeChatPageSize(Number.NaN)).toBe(DEFAULT_CHAT_PAGE_SIZE)
        expect(normalizeChatPageSize(Infinity)).toBe(DEFAULT_CHAT_PAGE_SIZE)
    })
})

describe('chat page boundaries', () => {
    it('keeps an empty chat on one empty page', () => {
        expect(getChatPageCount(0, 30)).toBe(1)
        expect(getChatPageBounds(0, 30, 0)).toEqual({
            page: 0,
            pageCount: 1,
            start: 0,
            end: 0,
        })
    })

    it('uses stable absolute-index, end-exclusive pages', () => {
        expect(getChatPageCount(61, 30)).toBe(3)
        expect(getChatPageBounds(61, 30, 1)).toEqual({
            page: 1,
            pageCount: 3,
            start: 30,
            end: 60,
        })
        expect(getChatPageBounds(61, 30, 99)).toEqual({
            page: 2,
            pageCount: 3,
            start: 60,
            end: 61,
        })
    })

    it('locates the latest page and the page containing an absolute message index', () => {
        expect(getLatestChatPage(61, 30)).toBe(2)
        expect(getChatPageForMessage(0, 61, 30)).toBe(0)
        expect(getChatPageForMessage(30, 61, 30)).toBe(1)
        expect(getChatPageForMessage(60, 61, 30)).toBe(2)
        expect(getChatPageForMessage(999, 61, 30)).toBe(2)
    })
})
