import { describe, expect, test } from 'vitest'
import {
    createContinuousHistoryController,
    getChatWindow,
    latestMessageScrollOptions,
    restoreMessageAnchor,
} from 'src/ts/chatWindow'

describe('continuous bounded chat history', () => {
    test('serially fills a nonoverflowing viewport and retains retry after a reverse failure', async () => {
        let remaining = 2
        let scrollable = false
        const controller = createContinuousHistoryController({
            hasOlder: () => remaining > 0,
            isScrollable: () => scrollable,
            loadOlder: async () => {
                remaining -= 1
                if (remaining === 0) scrollable = true
                return true
            },
        })

        await controller.fillViewport()
        expect(controller.failed).toBe(false)
        expect(remaining).toBe(0)

        const failing = createContinuousHistoryController({
            hasOlder: () => true,
            isScrollable: () => false,
            loadOlder: async () => { throw new Error('offline') },
        })
        await failing.fillViewport()
        expect(failing.failed).toBe(true)
        await expect(failing.retry()).resolves.toBe(false)
        expect(failing.failed).toBe(true)
        failing.reset()
        expect(failing.failed).toBe(false)
    })

    test('stops automatic fill when a backend reports older history without making viewport progress', async () => {
        let attempts = 0
        const controller = createContinuousHistoryController({
            hasOlder: () => true,
            isScrollable: () => false,
            maxLoads: 2,
            loadOlder: async () => {
                attempts += 1
                return true
            },
        })

        await expect(controller.fillViewport()).resolves.toBe(false)
        expect(attempts).toBe(2)
        expect(controller.failed).toBe(true)
    })

    test('keeps normal and saver DOM windows bounded, restores a prepend anchor, and bottoms Latest', () => {
        expect(getChatWindow({ total: 81, anchorIndex: 80, limit: 60 })).toMatchObject({ start: 21, end: 81 })
        expect(getChatWindow({ total: 81, anchorIndex: 80, limit: 40 })).toMatchObject({ start: 41, end: 81 })
        const scroller = { scrollTop: 25 } as HTMLElement
        expect(restoreMessageAnchor(scroller, { id: 'm41', top: 80 }, {
            getBoundingClientRect: () => ({ top: 112 }),
        } as unknown as HTMLElement)).toBe(true)
        expect(scroller.scrollTop).toBe(57)
        expect(latestMessageScrollOptions).toEqual({ block: 'end', behavior: 'instant' })
    })
})
