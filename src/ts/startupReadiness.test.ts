import { describe, expect, test, vi } from 'vitest'
import { startupHydrationErrorStore, startupHydrationStore } from './stores.svelte'
import { isStartupMutationReady, scheduleAfterTwoAnimationFrames } from './startupReadiness'

describe('startup readiness', () => {
    test('keeps mutation sources closed until deferred hydration succeeds', () => {
        startupHydrationStore.set(true)
        startupHydrationErrorStore.set(false)
        expect(isStartupMutationReady()).toBe(false)

        startupHydrationErrorStore.set(true)
        expect(isStartupMutationReady()).toBe(false)

        startupHydrationErrorStore.set(false)
        startupHydrationStore.set(false)
        expect(isStartupMutationReady()).toBe(true)
    })

    test('runs deferred hydration after exactly two animation frames without idle scheduling', async () => {
        const callbacks: FrameRequestCallback[] = []
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            callbacks.push(callback)
            return callbacks.length
        })
        const task = vi.fn()

        scheduleAfterTwoAnimationFrames(task, requestFrame)
        expect(task).not.toHaveBeenCalled()
        expect(callbacks).toHaveLength(1)

        callbacks.shift()?.(0)
        expect(task).not.toHaveBeenCalled()
        expect(callbacks).toHaveLength(1)

        callbacks.shift()?.(16)
        await Promise.resolve()
        expect(task).toHaveBeenCalledOnce()
        expect(requestFrame).toHaveBeenCalledTimes(2)
    })
})
