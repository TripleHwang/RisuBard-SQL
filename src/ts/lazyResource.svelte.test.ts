import { flushSync } from 'svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
    LazyResource,
    createLazyResource,
    isLazyLoadInFlight,
    resetLazyLoadsForTesting,
    sharedLoad,
} from './lazyResource.svelte'

/**
 * `.svelte.test.ts` so the runes compile. The whole point of this handle is
 * that a component's `{#if resource.loading}` re-renders when the load
 * settles; a correct value that is not reactive is a spinner that never stops.
 * Testing it in a plain `.test.ts` would leave `$state` uncompiled and prove
 * nothing about the thing components depend on.
 */

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

afterEach(() => {
    resetLazyLoadsForTesting()
    vi.restoreAllMocks()
})

describe('sharedLoad: one in-flight load per key', () => {
    test('concurrent callers for the same key share one load', async () => {
        const gate = deferred<string>()
        const loader = vi.fn(() => gate.promise)

        const first = sharedLoad('k', loader)
        const second = sharedLoad('k', loader)

        expect(loader).toHaveBeenCalledTimes(1)
        expect(first).toBe(second)

        gate.resolve('value')
        expect(await first).toBe('value')
        expect(await second).toBe('value')
    })

    test('the slot is freed on success so a later call reloads', async () => {
        const loader = vi.fn(async () => 'v')
        await sharedLoad('k', loader)
        expect(isLazyLoadInFlight('k')).toBe(false)
        await sharedLoad('k', loader)
        expect(loader).toHaveBeenCalledTimes(2)
    })

    /**
     * A rejected promise left in the map would turn one transport failure into
     * a key that can never be loaded again for the life of the session -- every
     * retry would await the same stale rejection.
     */
    test('the slot is freed on rejection so a failure is retryable', async () => {
        const loader = vi.fn(async () => { throw new Error('offline') })
        await expect(sharedLoad('k', loader)).rejects.toThrow('offline')
        expect(isLazyLoadInFlight('k')).toBe(false)
        await expect(sharedLoad('k', loader)).rejects.toThrow('offline')
        expect(loader).toHaveBeenCalledTimes(2)
    })

    /**
     * The reason the release is wired with `.then(release, release)` instead of
     * a `finally` inside the loader body: a loader that throws before its first
     * await would otherwise run the cleanup before the `set` that registered
     * it, and strand the rejection permanently.
     */
    test('a loader that throws synchronously still frees its slot', async () => {
        const thrower = () => { throw new Error('sync boom') }
        await expect(sharedLoad('k', thrower as unknown as () => Promise<never>)).rejects.toThrow('sync boom')
        expect(isLazyLoadInFlight('k')).toBe(false)
    })

    test('different keys do not share a load', async () => {
        const loader = vi.fn(async (key: string) => key)
        await Promise.all([sharedLoad('a', () => loader('a')), sharedLoad('b', () => loader('b'))])
        expect(loader).toHaveBeenCalledTimes(2)
    })
})

describe('LazyResource: a failure is a state, never a value', () => {
    test('a failed load keeps the error and refuses to produce a value', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const resource = new LazyResource<string[]>({
            scope: 'test',
            key: () => 'k',
            load: async () => { throw new Error('the network went away') },
            auto: false,
        })

        await resource.request()

        expect(resource.status).toBe('failed')
        expect(resource.failed).toBe(true)
        expect(resource.ready).toBe(false)
        // Not `[]`. An empty list is the claim "there are none of these", and
        // nobody is entitled to make it about data that could not be read.
        expect(resource.value).toBeUndefined()
        expect(resource.errorMessage).toBe('the network went away')
    })

    test('a failure is reported even when the request that made it is superseded', async () => {
        const reported: unknown[] = []
        let key = 'first'
        const gate = deferred<string>()
        const resource = new LazyResource<string>({
            scope: 'test',
            key: () => key,
            load: async (requested) => {
                if (requested === 'first') return gate.promise
                return 'second value'
            },
            auto: false,
            onError: (error) => reported.push(error),
        })

        const stale = resource.request()
        key = 'second'
        await resource.request()
        expect(resource.status).toBe('ready')

        gate.reject(new Error('late failure'))
        await stale

        // The superseded load must not overwrite the newer result...
        expect(resource.status).toBe('ready')
        expect(resource.value).toBe('second value')
        // ...but it really did fail, and losing that to a race would be exactly
        // the silent failure this module exists to prevent.
        expect((reported[0] as Error).message).toBe('late failure')
    })

    test('retry is the way out of a failure, and it really reloads', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        let attempt = 0
        const resource = new LazyResource<string>({
            scope: 'test',
            key: () => 'k',
            load: async () => {
                attempt += 1
                if (attempt === 1) throw new Error('first attempt failed')
                return 'recovered'
            },
            auto: false,
        })

        await resource.request()
        expect(resource.status).toBe('failed')

        await resource.retry()
        expect(resource.status).toBe('ready')
        expect(resource.value).toBe('recovered')
        expect(attempt).toBe(2)
    })

    test('a late result for an abandoned key does not overwrite the current one', async () => {
        let key = 'a'
        const slow = deferred<string>()
        const resource = new LazyResource<string>({
            scope: 'test',
            key: () => key,
            load: async (requested) => (requested === 'a' ? slow.promise : `value:${requested}`),
            auto: false,
        })

        const abandoned = resource.request()
        key = 'b'
        await resource.request()
        expect(resource.value).toBe('value:b')

        slow.resolve('value:a')
        await abandoned
        expect(resource.stateKey).toBe('b')
        expect(resource.value).toBe('value:b')
    })

    test('changing the key drops the previous value instead of showing it under a new name', async () => {
        let key = 'a'
        const gate = deferred<string>()
        const resource = new LazyResource<string>({
            scope: 'test',
            key: () => key,
            load: async (requested) => (requested === 'a' ? 'value:a' : gate.promise),
            auto: false,
        })

        await resource.request()
        expect(resource.value).toBe('value:a')

        key = 'b'
        const pending = resource.request()
        expect(resource.status).toBe('loading')
        expect(resource.value).toBeUndefined()

        gate.resolve('value:b')
        await pending
        expect(resource.value).toBe('value:b')
    })

    test('two resources with the same key but different scopes do not share a load', async () => {
        const seen: string[] = []
        const one = new LazyResource<string>({
            scope: 'personas', key: () => 'char-1', auto: false,
            load: async () => { seen.push('personas'); return 'personas' },
        })
        const two = new LazyResource<string>({
            scope: 'chats', key: () => 'char-1', auto: false,
            load: async () => { seen.push('chats'); return 'chats' },
        })
        await Promise.all([one.request(), two.request()])
        expect(seen.sort()).toEqual(['chats', 'personas'])
        expect(one.value).toBe('personas')
        expect(two.value).toBe('chats')
    })

    test('a null key means nothing to load, not an empty result', async () => {
        const load = vi.fn(async () => 'v')
        const resource = new LazyResource<string>({ scope: 'test', key: () => null, load, auto: false })
        await resource.request()
        expect(load).not.toHaveBeenCalled()
        expect(resource.status).toBe('idle')
        expect(resource.value).toBeUndefined()
    })
})

describe('LazyResource: the state a component renders from is reactive', () => {
    /**
     * This is the effect a template's `{#if resource.loading}` compiles to. A
     * status that is correct but not reactive is a spinner that never stops and
     * an error card that never appears.
     */
    test('an effect reading status re-runs as the load settles', async () => {
        const gate = deferred<string>()
        const resource = new LazyResource<string>({
            scope: 'test', key: () => 'k', load: () => gate.promise, auto: false,
        })
        const seen: string[] = []
        const stop = $effect.root(() => {
            $effect(() => { seen.push(resource.status) })
        })
        flushSync()
        expect(seen).toEqual(['idle'])

        const pending = resource.request()
        flushSync()
        expect(seen).toEqual(['idle', 'loading'])

        gate.resolve('done')
        await pending
        flushSync()
        expect(seen).toEqual(['idle', 'loading', 'ready'])
        stop()
    })

    /**
     * "Load it when I appear": the auto effect fires once the key stops being
     * null, and -- because it writes the status it would otherwise depend on --
     * must not re-trigger itself.
     */
    test('auto mode loads when the key appears and does not loop', async () => {
        let key = $state<string | null>(null)
        const load = vi.fn(async (requested: string) => `value:${requested}`)
        let resource!: LazyResource<string>
        const stop = $effect.root(() => {
            resource = createLazyResource({ scope: 'test', key: () => key, load })
        })

        flushSync()
        expect(load).not.toHaveBeenCalled()
        expect(resource.status).toBe('idle')

        key = 'k'
        flushSync()
        expect(load).toHaveBeenCalledTimes(1)
        await Promise.resolve()
        await Promise.resolve()
        flushSync()
        expect(resource.status).toBe('ready')
        expect(resource.value).toBe('value:k')

        // Settling wrote status/value; the effect must not have re-fired on it.
        flushSync()
        expect(load).toHaveBeenCalledTimes(1)
        stop()
    })

    test('auto mode resets when the key goes back to null, so a stale failure is not repainted', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        let key = $state<string | null>('k')
        let resource!: LazyResource<string>
        const stop = $effect.root(() => {
            resource = createLazyResource({
                scope: 'test',
                key: () => key,
                load: async () => { throw new Error('nope') },
            })
        })
        flushSync()
        await Promise.resolve()
        await Promise.resolve()
        flushSync()
        expect(resource.status).toBe('failed')

        key = null
        flushSync()
        expect(resource.status).toBe('idle')
        expect(resource.error).toBeUndefined()
        stop()
    })
})
