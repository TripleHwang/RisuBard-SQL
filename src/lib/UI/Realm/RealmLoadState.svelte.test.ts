import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import RealmMain from './RealmMain.svelte'
import { DBState } from 'src/ts/stores.svelte'
import { resetLazyLoadsForTesting } from 'src/ts/lazyResource.svelte'

/**
 * RisuRealm is the surface the user named: "RisuRealm loads only itself".
 *
 * The defect this pins down is not that it loaded too much -- it is what it
 * showed when it could not load at all. `getRisuHub` caught every failure and
 * returned `[]`, and the browser rendered its empty-result message over it. A
 * user reading "No RisuRealm characters found." concludes their search has no
 * matches and searches for something else; the truth was that the request never
 * reached the server, and nothing anywhere said so.
 *
 * A component test rather than a source-text assertion: the claim is about what
 * a user sees when the network is down, so the component is really mounted and
 * really given a failing `fetch`.
 */

let host: HTMLDivElement | null = null
let app: ReturnType<typeof mount> | null = null

function text(): string {
    return host?.textContent ?? ''
}

/** Let the fetch promise, the resource state write, and the effects all settle. */
async function settle(): Promise<void> {
    for (let i = 0; i < 12; i++) {
        await Promise.resolve()
        flushSync()
    }
}

function render() {
    host = document.createElement('div')
    document.body.append(host)
    app = mount(RealmMain, { target: host })
}

beforeEach(() => {
    resetLazyLoadsForTesting()
    DBState.db ??= {} as never
    ;(DBState.db as { language?: string }).language = 'en'
})

afterEach(() => {
    if (app) unmount(app)
    app = null
    host?.remove()
    host = null
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    resetLazyLoadsForTesting()
})

describe('RisuRealm distinguishes "no results" from "could not ask"', () => {
    test('a failed hub request shows a failure, not an empty result list', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))

        render()
        await settle()

        expect(host?.querySelector('[role="alert"]')).not.toBeNull()
        expect(text()).toContain('Could not reach RisuRealm')
        expect(text()).not.toContain('No RisuRealm characters found.')
    })

    test('a non-200 hub response is a failure too, not zero characters', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.stubGlobal('fetch', vi.fn(async () => ({
            status: 503,
            json: async () => { throw new Error('should not be read') },
        })))

        render()
        await settle()

        expect(host?.querySelector('[role="alert"]')).not.toBeNull()
        expect(text()).not.toContain('No RisuRealm characters found.')
    })

    test('an actually empty result still reads as empty', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ status: 200, json: async () => [] })))

        render()
        await settle()

        expect(host?.querySelector('[role="alert"]')).toBeNull()
        expect(text()).toContain('No RisuRealm characters found.')
    })

    test('the page renders its own loading state while the hub is in flight', async () => {
        let release: (value: unknown) => void = () => {}
        vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
            release = () => resolve({ status: 200, json: async () => [] })
        })))

        render()
        flushSync()

        expect(host?.querySelector('[role="status"]')).not.toBeNull()
        // Nothing that blocks the rest of the app: the search controls stay in
        // the DOM and stay interactive while the request is out.
        expect(host?.querySelector('input[aria-label="Search RisuRealm"]')).not.toBeNull()
        expect(document.querySelector('.risu-modal-overlay')).toBeNull()

        release(null)
        await settle()
        expect(host?.querySelector('[role="status"]')).toBeNull()
    })
})
