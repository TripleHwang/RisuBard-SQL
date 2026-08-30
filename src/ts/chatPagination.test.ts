import { describe, expect, it } from 'vitest'
import {
    DEFAULT_CHAT_PAGE_SIZE,
    MAX_CHAT_PAGE_SIZE,
    MIN_CHAT_PAGE_SIZE,
    normalizeChatPageSize,
} from './chatPagination'

/**
 * The page-boundary helpers this file also covered -- `getChatPageBounds`,
 * `getChatPageCount`, `getChatPageForMessage`, `getLatestChatPage` -- are gone
 * along with the numbered pages they sliced the chat view into. The chat screen
 * follows the scroll now; see `src/lib/ChatScreens/ChatScrollWindow.svelte.test.ts`.
 *
 * The page size itself survives, because loading older history is still done a
 * page at a time.
 */
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
