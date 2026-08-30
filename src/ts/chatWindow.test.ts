import { describe, expect, it } from 'vitest'
import {
    getChatWindow,
    estimateSpacerHeight,
    stepChatWindowCenter,
    isCurrentChatWindowRequest,
    validateOlderMessagePage,
    reverseSpacerOrder,
} from './chatWindow'

describe('chat DOM window', () => {
    it('caps normal and saver windows around the loaded-page anchor', () => {
        expect(getChatWindow({ total: 200, anchorIndex: 120, limit: 60 })).toMatchObject({ start: 90, end: 150, beforeCount: 90, afterCount: 50 })
        expect(getChatWindow({ total: 200, anchorIndex: 120, limit: 40 })).toMatchObject({ start: 100, end: 140 })
    })

    it('estimates spacers from measured row heights', () => {
        expect(estimateSpacerHeight([20, 30], 5, 24)).toBe(125)
    })

    it('steps the window half a screen at a time, and reports when it cannot', () => {
        const middle = getChatWindow({ total: 400, anchorIndex: 200, limit: 60 })
        expect(stepChatWindowCenter(middle, 400, 60, -1)).toBe(169)
        expect(stepChatWindowCenter(middle, 400, 60, 1)).toBe(229)

        // At either extreme the step resolves to the window it was given, which
        // is how the caller learns to ask storage instead of sliding further.
        const oldest = getChatWindow({ total: 400, anchorIndex: 0, limit: 60 })
        expect(getChatWindow({ total: 400, anchorIndex: stepChatWindowCenter(oldest, 400, 60, -1), limit: 60 }))
            .toMatchObject({ start: oldest.start, end: oldest.end })
        const newest = getChatWindow({ total: 400, anchorIndex: 399, limit: 60 })
        expect(getChatWindow({ total: 400, anchorIndex: stepChatWindowCenter(newest, 400, 60, 1), limit: 60 }))
            .toMatchObject({ start: newest.start, end: newest.end })
    })

    it('places reverse-flex spacers on their visual sides', () => {
        expect(reverseSpacerOrder).toEqual(['after', 'messages', 'before'])
    })

    it('cancels a pending older-page anchor after the user changes pages', () => {
        const pending = { key: 'character/chat', version: 4 }
        // The fetch resolves after selectChatPage has incremented the version.
        expect(isCurrentChatWindowRequest(pending, { key: 'character/chat', version: 5 })).toBe(false)
        expect(isCurrentChatWindowRequest(pending, { key: 'character/chat', version: 4 })).toBe(true)
    })
})

describe('older reverse page validation', () => {
    const page = (offset: number, ids: string[], total = 100) => ({ offset, total, messages: ids.map(chatId => ({ chatId })) })

    it('accepts the contiguous page immediately before the current window', () => {
        expect(validateOlderMessagePage(page(20, ['a', 'b']), { offset: 22, total: 100, ids: ['c'] }).map(message => message.chatId)).toEqual(['a', 'b'])
    })

    it.each([
        ['duplicates', page(20, ['a', 'a'])],
        ['noncontiguous', page(19, ['a', 'b'])],
    ])('rejects %s reverse pages', (_, incoming) => {
        expect(() => validateOlderMessagePage(incoming, { offset: 22, total: 100, ids: ['c'] })).toThrow()
    })

    it('accepts a page whose total moved, because the window count is a snapshot', () => {
        // `current.total` is counted when the window is built. Deleting a message
        // afterwards legitimately moves the server's count, and rejecting that
        // stranded the rest of the history behind a throw for the whole session.
        // Contiguity and identity are what catch real corruption; the caller
        // adopts the page's fresh total.
        expect(
            validateOlderMessagePage(page(20, ['a', 'b'], 99), { offset: 22, total: 100, ids: ['c'] })
                .map(message => message.chatId),
        ).toEqual(['a', 'b'])
    })
})
