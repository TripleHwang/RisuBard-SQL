import { describe, expect, it } from 'vitest'
import {
    getChatWindow,
    estimateSpacerHeight,
    restoreMessageAnchor,
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

    it('restores a visible message anchor by its top delta', () => {
        const scroller = { scrollTop: 100 } as HTMLElement
        const anchor = { id: 'm-1', top: 40 }
        const element = { getBoundingClientRect: () => ({ top: 68 }) } as unknown as HTMLElement
        expect(restoreMessageAnchor(scroller, anchor, element)).toBe(true)
        expect(scroller.scrollTop).toBe(128)
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
        ['changed total', page(20, ['a', 'b'], 99)],
    ])('rejects %s reverse pages', (_, incoming) => {
        expect(() => validateOlderMessagePage(incoming, { offset: 22, total: 100, ids: ['c'] })).toThrow()
    })
})
