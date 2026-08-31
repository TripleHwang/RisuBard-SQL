import { describe, expect, test, vi } from 'vitest'
import {
    captureChatScrollAnchor,
    restoreChatScrollAnchor,
} from './chatScrollAnchor'

function rect(top: number, bottom: number): DOMRect {
    return {
        top,
        bottom,
        left: 0,
        right: 600,
        width: 600,
        height: bottom - top,
        x: 0,
        y: top,
        toJSON: () => ({}),
    } as DOMRect
}

function createChatLayout(
    messageRects: Array<{ index: number; top: number; bottom: number }>,
    scrollTop = -200,
) {
    const container = document.createElement('div')
    Object.defineProperty(container, 'scrollTop', { value: scrollTop, writable: true })
    container.getBoundingClientRect = () => rect(0, 500)
    container.scrollTo = vi.fn()

    const elements = new Map<number, HTMLElement>()
    for (const messageRect of messageRects) {
        const element = document.createElement('article')
        element.dataset.chatIndex = String(messageRect.index)
        element.getBoundingClientRect = () => rect(messageRect.top, messageRect.bottom)
        container.append(element)
        elements.set(messageRect.index, element)
    }

    return { container, elements }
}

describe('chat scroll anchor', () => {
    test('captures the message crossing the viewport top and its relative offset', () => {
        const { container } = createChatLayout([
            { index: 4, top: -80, bottom: 100 },
            { index: 5, top: 110, bottom: 310 },
            { index: 9, top: 900, bottom: 1100 },
        ])

        expect(captureChatScrollAnchor(container, 'character/chat', 10)).toEqual({
            contextKey: 'character/chat',
            messageIndex: 4,
            messageCount: 10,
            offsetTop: -80,
            atLatest: false,
        })
    })

    test('restores an anchor by correcting only the chat container scroll position', () => {
        const { container, elements } = createChatLayout([
            { index: 4, top: -30, bottom: 150 },
            { index: 9, top: 900, bottom: 1100 },
        ])
        elements.get(4)!.getBoundingClientRect = () => rect(-30, 150)

        const result = restoreChatScrollAnchor(container, {
            contextKey: 'character/chat',
            messageIndex: 4,
            messageCount: 10,
            offsetTop: -80,
            atLatest: false,
        }, 'character/chat', 10)

        expect(result).toBe('restored')
        expect(container.scrollTo).toHaveBeenCalledWith({ top: -150, behavior: 'instant' })
    })

    test('leaves appended-reply auto-scroll in control when the latest message was visible', () => {
        const { container } = createChatLayout([
            { index: 8, top: -70, bottom: 300 },
            { index: 9, top: 320, bottom: 560 },
        ])
        const anchor = captureChatScrollAnchor(container, 'character/chat', 10)

        expect(anchor?.atLatest).toBe(true)
        expect(restoreChatScrollAnchor(container, anchor!, 'character/chat', 11)).toBe('new-message')
        expect(container.scrollTo).not.toHaveBeenCalled()
    })
})
