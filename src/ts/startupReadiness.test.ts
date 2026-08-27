import { describe, expect, test, vi } from 'vitest'
import { startupHydrationErrorStore, startupHydrationStore } from './stores.svelte'
import { dispatchStartupURLImport, isStartupMutationReady, runStartupMutation, scheduleAfterTwoAnimationFrames } from './startupReadiness'

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

    test('suppresses every guarded startup mutation until a successful deferred hydration', () => {
        const mutations = ['quick settings', 'new character', 'vault', 'reorder', 'realm download', 'url import']
        const invoke = vi.fn()

        startupHydrationStore.set(true)
        startupHydrationErrorStore.set(false)
        for (const mutation of mutations) runStartupMutation(() => invoke(mutation))
        startupHydrationErrorStore.set(true)
        for (const mutation of mutations) runStartupMutation(() => invoke(mutation))
        expect(invoke).not.toHaveBeenCalled()

        startupHydrationErrorStore.set(false)
        startupHydrationStore.set(false)
        for (const mutation of mutations) runStartupMutation(() => invoke(mutation))
        expect(invoke).toHaveBeenCalledTimes(mutations.length)
        expect(invoke.mock.calls.map(([name]) => name)).toEqual(mutations)
    })

    test('dispatches a URL import exactly once only after startup readiness', async () => {
        const importer = vi.fn()

        startupHydrationStore.set(true)
        startupHydrationErrorStore.set(false)
        expect(await dispatchStartupURLImport(importer)).toBe(false)
        startupHydrationErrorStore.set(true)
        expect(await dispatchStartupURLImport(importer)).toBe(false)
        expect(importer).not.toHaveBeenCalled()

        startupHydrationErrorStore.set(false)
        startupHydrationStore.set(false)
        expect(await dispatchStartupURLImport(importer)).toBe(true)
        expect(importer).toHaveBeenCalledOnce()
    })
})
