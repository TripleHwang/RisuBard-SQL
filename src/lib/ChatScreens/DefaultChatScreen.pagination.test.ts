import { describe, expect, test } from 'vitest'
import {
    createContinuousHistoryController,
    createContinuousHistoryControllerSlot,
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
            progress: () => 2 - remaining,
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
            progress: () => 0,
            loadOlder: async () => { throw new Error('offline') },
        })
        await failing.fillViewport()
        expect(failing.failed).toBe(true)
        await expect(failing.retry()).resolves.toBe(false)
        expect(failing.failed).toBe(true)
        failing.reset()
        expect(failing.failed).toBe(false)
    })

    test('stops automatic fill when a backend reports older history without making forward progress', async () => {
        let attempts = 0
        const controller = createContinuousHistoryController({
            hasOlder: () => true,
            isScrollable: () => false,
            progress: () => 40,
            loadOlder: async () => {
                attempts += 1
                return true
            },
        })

        await expect(controller.fillViewport()).resolves.toBe(false)
        expect(attempts).toBe(1)
        expect(controller.failed).toBe(true)
    })

    test('replaces an in-flight controller on chat selection instead of joining its request', async () => {
        let resolveOld!: (value: boolean) => void
        const oldRequest = new Promise<boolean>((resolve) => { resolveOld = resolve })
        let calls = 0
        const slot = createContinuousHistoryControllerSlot(() => createContinuousHistoryController({
            hasOlder: () => false,
            isScrollable: () => true,
            progress: () => calls,
            loadOlder: () => ++calls === 1 ? oldRequest : Promise.resolve(true),
        }))

        const old = slot.current
        const pending = old.retry()
        const fresh = slot.replace()
        await expect(fresh.retry()).resolves.toBe(true)
        expect(calls).toBe(2)
        resolveOld(false)
        await expect(pending).resolves.toBe(false)
        expect(fresh.failed).toBe(false)
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
