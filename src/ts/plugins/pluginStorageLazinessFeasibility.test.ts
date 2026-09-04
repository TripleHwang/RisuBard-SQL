/**
 * Evidence for the two claims a per-key plugin-storage design turns on.
 * These tests assert current behaviour only; nothing here changes it.
 *
 * 1. The v3 API bridge already awaits whatever a host method returns, so a
 *    host-side `_getPluginStorage` that becomes an async per-key fetch is
 *    indistinguishable from today's synchronous one to a v3 plugin. The v3
 *    surface is Promise-returning by construction (every call crosses
 *    `postMessage`), which is why `apiV3/risuai.d.ts` documents it that way.
 *
 * 2. The v2.0/v2.1 surface has no such seam: `getV2PluginAPIs().pluginStorage`
 *    hands back plain synchronous functions whose return values are used
 *    directly. A Promise there is not a slower answer, it is a wrong one.
 */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

import { SandboxHost } from './apiV3/factory'
import { getV2PluginAPIs } from './plugins.svelte'
import { DBState } from '../stores.svelte'
import { resetDeferredRootKeys } from '../storage/sql/deferredRootKeys'

// `collectTransferables` names `ImageBitmap` unguarded; happy-dom has no such
// global, so define a stand-in for the duration of these tests. Nothing here
// depends on its behaviour, only on the identifier resolving.
const hadImageBitmap = 'ImageBitmap' in globalThis
if (!hadImageBitmap) (globalThis as any).ImageBitmap = class ImageBitmap {}

afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
    resetDeferredRootKeys()
})

afterAll(() => {
    if (!hadImageBitmap) delete (globalThis as any).ImageBitmap
})

/**
 * Drive one CALL_ROOT through the host exactly as the sandboxed iframe does,
 * and hand back the RESPONSE the host posts.
 */
async function callRoot(api: Record<string, unknown>, method: string, args: unknown[]) {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const host = new SandboxHost(api)
    host.run(iframe, '')

    const contentWindow = iframe.contentWindow as unknown as Window
    const posted: any[] = []
    vi.spyOn(contentWindow as any, 'postMessage').mockImplementation((message: any) => {
        posted.push(message)
    })

    window.dispatchEvent(new MessageEvent('message', {
        source: contentWindow,
        data: { type: 'CALL_ROOT', reqId: 'req_1', method, args },
    }))

    // The handler is async; let its microtasks and the fake I/O settle.
    for (let i = 0; i < 20 && posted.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1))
    }
    host.terminate()
    return posted[0]
}

describe('v3 plugin storage can be made per-key without a guest-visible change', () => {
    it('resolves a Promise-returning host method before answering the sandbox', async () => {
        // Stand-in for a `_getPluginStorage` that fetches one row over HTTP.
        const perKeyRead = vi.fn(async (key: string) => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            return { key, value: 'loaded lazily' }
        })

        const response = await callRoot({ _getPluginStorage: perKeyRead }, '_getPluginStorage', ['libra.memory'])

        expect(perKeyRead).toHaveBeenCalledWith('libra.memory')
        expect(response.type).toBe('RESPONSE')
        expect(response.error).toBeUndefined()
        // The resolved value, not a Promise: the bridge awaited it for us.
        expect(response.result).toEqual({ key: 'libra.memory', value: 'loaded lazily' })
    })

    it('turns a rejected per-key read into an error, never into an empty answer', async () => {
        const failingRead = vi.fn(async () => {
            throw new Error('storage unreachable')
        })

        const response = await callRoot({ _getPluginStorage: failingRead }, '_getPluginStorage', ['libra.memory'])

        expect(response.error).toBe('storage unreachable')
        expect('result' in response).toBe(false)
    })
})

describe('the v2 plugin storage surface has no seam for an async read', () => {
    it('returns values synchronously, so a Promise would be handed to the plugin as the value', () => {
        const previous = DBState.db
        DBState.db = {
            characters: [],
            plugins: [],
            pluginCustomStorage: { 'libra.memory': 'stored' },
        } as any
        try {
            const apis = getV2PluginAPIs() as any

            const read = apis.pluginStorage.getItem('libra.memory')
            expect(read).toBe('stored')
            expect(read).not.toBeInstanceOf(Promise)

            // `keys()`/`length()` are whole-map by definition: they answer from
            // `Object.keys` of the in-memory map, so no per-key scheme can serve
            // them without the full key list.
            expect(apis.pluginStorage.keys()).toEqual(['libra.memory'])
            expect(apis.pluginStorage.length()).toBe(1)
        } finally {
            DBState.db = previous
        }
    })
})
