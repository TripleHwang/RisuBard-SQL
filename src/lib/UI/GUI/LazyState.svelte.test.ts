import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, test, vi } from 'vitest'

import LazyState from './LazyState.svelte'
import { LazyResource, createLazyResource, resetLazyLoadsForTesting } from 'src/ts/lazyResource.svelte'

/**
 * What `LazyState` paints for each of the four states, and in particular what
 * it paints for `'idle'` -- which does not mean the same thing for both kinds
 * of resource.
 *
 * An AUTO resource requests the moment its key appears, so idle is the single
 * instant before that; painting real content there flashes an empty state, and
 * the loading branch is the right fallback.
 *
 * A MANUAL resource (`auto: false` -- the character and chat openers, anything
 * behind a button) RESTS at idle. Falling back to the loading branch there put
 * a permanent "Loading…" row above lists nobody had touched: the mobile
 * character list showed one the whole time it was open, and so did the chat
 * list dialog. A spinner that never stops is worse than no spinner, because it
 * tells the user something is happening when nothing is.
 *
 * `.svelte.test.ts` so the runes compile: the whole point of the handle is that
 * these branches re-render as the load settles.
 */

let host: HTMLDivElement | null = null
let app: ReturnType<typeof mount> | null = null

function render(resource: LazyResource<unknown>) {
    host = document.createElement('div')
    document.body.append(host)
    app = mount(LazyState, { target: host, props: { resource } })
    flushSync()
}

function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

afterEach(() => {
    if (app) unmount(app)
    app = null
    host?.remove()
    host = null
    resetLazyLoadsForTesting()
    vi.restoreAllMocks()
})

describe('what LazyState paints while nothing has been asked for', () => {
    test('a manual resource at rest paints nothing at all', () => {
        const resource = new LazyResource<string>({
            scope: 'test', key: () => 'k', auto: false,
            load: async () => 'v',
        })
        render(resource)

        expect(resource.status).toBe('idle')
        // Not a spinner. Nothing has been requested, and a manual resource may
        // sit here for the entire life of the screen.
        expect(host?.querySelector('[role="status"]')).toBeNull()
        expect(host?.textContent?.trim()).toBe('')
    })

    test('an auto resource still shows the loading branch in the instant before it requests', () => {
        // Key null so the effect never fires: this is the idle frame, held.
        let resource!: LazyResource<string>
        const stop = $effect.root(() => {
            resource = createLazyResource({
                scope: 'test', key: () => null, load: async () => 'v',
            })
        })
        flushSync()
        render(resource)

        expect(resource.status).toBe('idle')
        expect(resource.autoRequests).toBe(true)
        // Real content here would flash an empty state between mount and the
        // request the effect is about to make.
        expect(host?.querySelector('[role="status"]')).not.toBeNull()
        stop()
    })
})

describe('what LazyState paints once a manual resource is used', () => {
    test('pressing it shows the loading branch, and settling clears it', async () => {
        const gate = deferred<string>()
        const resource = new LazyResource<string>({
            scope: 'test', key: () => 'k', auto: false, load: () => gate.promise,
        })
        render(resource)
        expect(host?.querySelector('[role="status"]')).toBeNull()

        const pending = resource.request()
        flushSync()
        expect(host?.querySelector('[role="status"]')).not.toBeNull()

        gate.resolve('v')
        await pending
        flushSync()
        expect(host?.querySelector('[role="status"]')).toBeNull()
    })

    /**
     * The reason the failure branch has a default at all: a component that
     * forgets to write one shows the user that the load failed, instead of
     * falling through to whatever it renders on success -- which for a list is
     * an empty list, and an empty list is the claim "there are none of these".
     */
    test('a failure paints an alert with the error and a retry, not an empty subtree', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        let attempt = 0
        const resource = new LazyResource<string>({
            scope: 'test', key: () => 'k', auto: false,
            load: async () => {
                attempt += 1
                if (attempt === 1) throw new Error('the network went away')
                return 'v'
            },
        })
        render(resource)

        await resource.request()
        flushSync()

        const alert = host?.querySelector('[role="alert"]')
        expect(alert).not.toBeNull()
        expect(alert?.textContent ?? '').toContain('the network went away')

        const retry = alert?.querySelector('button')
        expect(retry).toBeTruthy()
        retry!.click()
        // The retry really reloads; it is the only way out of 'failed'.
        for (let i = 0; i < 10; i++) { await Promise.resolve(); flushSync() }
        expect(attempt).toBe(2)
        expect(host?.querySelector('[role="alert"]')).toBeNull()
    })

    /**
     * A resource that has been used and then reset is back at rest, so it must
     * go back to painting nothing rather than repainting a stale failure. This
     * is what a surface closing relies on.
     */
    test('resetting a failed manual resource paints nothing again', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const resource = new LazyResource<string>({
            scope: 'test', key: () => 'k', auto: false,
            load: async () => { throw new Error('nope') },
        })
        render(resource)

        await resource.request()
        flushSync()
        expect(host?.querySelector('[role="alert"]')).not.toBeNull()

        resource.reset()
        flushSync()
        expect(host?.querySelector('[role="alert"]')).toBeNull()
        expect(host?.querySelector('[role="status"]')).toBeNull()
        expect(host?.textContent?.trim()).toBe('')
    })
})
