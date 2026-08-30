import { describe, expect, it, vi } from 'vitest'

import { createOlderMessageLoader } from './chatScrollPaging'

/**
 * The gate between "the user scrolled to the oldest message on screen" and
 * "fetch the page before it".
 *
 * Scrolling fires this far more often than a button ever did -- an
 * IntersectionObserver can report the same sentinel several times inside one
 * flick -- so the three properties below are the ones a user would otherwise
 * feel as duplicated pages, interleaved history, or a spinner that never ends.
 */
function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

describe('the older-message scroll loader', () => {
    it('coalesces a burst of requests into a single fetch', async () => {
        const gate = deferred<void>()
        const load = vi.fn(() => gate.promise)
        const loader = createOlderMessageLoader({ hasOlder: () => true, load })

        // A fast scroll: the sentinel reports itself over and over before the
        // first page has come back. Every extra fetch here would prepend
        // another page the user never asked for, and two in flight together
        // could interleave their splices.
        const outcomes = [loader.request(), loader.request(), loader.request(), loader.request()]
        expect(load).toHaveBeenCalledTimes(1)

        gate.resolve()
        expect(await Promise.all(outcomes)).toEqual(['loaded', 'coalesced', 'coalesced', 'coalesced'])
        expect(load).toHaveBeenCalledTimes(1)
    })

    it('lets a later scroll load the next page once the first has landed', async () => {
        const load = vi.fn(async () => {})
        const loader = createOlderMessageLoader({ hasOlder: () => true, load })

        expect(await loader.request()).toBe('loaded')
        expect(await loader.request()).toBe('loaded')
        expect(load).toHaveBeenCalledTimes(2)
    })

    it('stops cleanly at the start of the persisted history', async () => {
        const load = vi.fn(async () => {})
        const loadingStates: boolean[] = []
        const onError = vi.fn()
        const loader = createOlderMessageLoader({
            hasOlder: () => false,
            load,
            onLoadingChange: (loading) => loadingStates.push(loading),
            onError,
        })

        expect(await loader.request()).toBe('exhausted')
        expect(await loader.request()).toBe('exhausted')

        expect(load).not.toHaveBeenCalled()
        expect(onError).not.toHaveBeenCalled()
        // The end of history is a normal stop. Raising the loading flag here is
        // what a stuck spinner is made of: nothing is coming to lower it.
        expect(loadingStates).toEqual([])
        expect(loader.loading).toBe(false)
    })

    it('lowers the loading flag and reports the failure when a page cannot be read', async () => {
        const failure = new Error('reverse page is not contiguous')
        const onError = vi.fn()
        const loadingStates: boolean[] = []
        const loader = createOlderMessageLoader({
            hasOlder: () => true,
            load: async () => { throw failure },
            onLoadingChange: (loading) => loadingStates.push(loading),
            onError,
        })

        expect(await loader.request()).toBe('failed')

        // Observable, and not left mid-load: a swallowed rejection here is the
        // "nothing happened and nobody was told" failure this screen already had.
        expect(onError).toHaveBeenCalledWith(failure)
        expect(loadingStates).toEqual([true, false])
        expect(loader.loading).toBe(false)
    })

    it('does not wedge itself when the load throws before it ever suspends', async () => {
        const failure = new Error('no character selected')
        const onError = vi.fn()
        const loader = createOlderMessageLoader({
            hasOlder: () => true,
            // Synchronous throw: the in-flight bookkeeping must not be cleared
            // before it is recorded, or the loader refuses every later request.
            load: () => { throw failure },
            onError,
        })

        expect(await loader.request()).toBe('failed')
        expect(loader.loading).toBe(false)
        expect(await loader.request()).toBe('failed')
        expect(onError).toHaveBeenCalledTimes(2)
    })
})
