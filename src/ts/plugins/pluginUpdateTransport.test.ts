import { beforeEach, describe, expect, test, vi } from 'vitest'

// Exercises the REAL checkPluginUpdate()/updatePlugin() from plugins.svelte.ts
// (not the generic runPluginUpdate() unit tested in pluginUpdate.test.ts), to
// pin down requirements from the plugin-update hotfix:
//   1. the update CHECK and the actual DOWNLOAD share one transport
//      (fetchNative, not a raw `fetch`), so proxy/CORS handling can't diverge.
//   2. a server that rejects/ignores the Range header used by the check is
//      retried with a plain GET instead of being treated as "no update".
//   3. the distinct failure codes from runPluginUpdate() actually come out
//      the other end of the real importPlugin()-backed pipeline.
//
// Each test uses its own plugin name/updateURL: checkPluginUpdate() keeps a
// module-level `updateCache` keyed by name, so reusing a name across tests
// would let an earlier test's cached "update found" answer hide a later
// test's fetchNative call.

const runtime = vi.hoisted(() => ({
    db: {
        plugins: [] as any[],
        pluginCustomStorage: {} as Record<string, unknown>,
        allowV2Plugin: false,
    },
    fetchNative: vi.fn(),
    save: vi.fn(),
    loadV3Plugins: vi.fn(),
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => runtime.db,
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
    getCurrentCharacter: vi.fn(),
}))
vi.mock('../alert', () => ({ alertConfirm: vi.fn(), alertError: vi.fn(), alertPluginConfirm: vi.fn() }))
vi.mock('../util', () => ({ selectSingleFile: vi.fn(), sleep: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({
    fetchNative: runtime.fetchNative,
    globalFetch: vi.fn(),
    readImage: vi.fn(),
    requestImmediateSave: runtime.save,
    saveAsset: vi.fn(),
    toGetter: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({
    DBState: { db: runtime.db }, hotReloading: [], pluginAlertModalStore: { open: false, errors: [] }, selectedCharID: {},
}))
vi.mock('./pluginSafety', () => ({ checkCodeSafety: vi.fn(async () => ({ isSafe: true, errors: [] })) }))
vi.mock('./pluginSafeClass', () => ({ SafeDocument: {}, SafeIdbFactory: {}, SafeLocalStorage: class {} }))
vi.mock('./apiV3/v3.svelte', () => ({ loadV3Plugins: runtime.loadV3Plugins }))
vi.mock('./apiV3/transpiler', () => ({ pluginCodeTranspiler: vi.fn() }))
vi.mock('../builtin/pagefold', () => ({
    PAGEFOLD_PLUGIN_NAME: 'pagefold',
    loadBuiltInPageFoldPlugin: vi.fn(async () => ({ name: 'pagefold', enabled: true, version: '3.0' })),
}))

import { checkPluginUpdate, updatePlugin } from './plugins.svelte'

function response(body: string, status: number): Response {
    return new Response(body, { status })
}

// A cross-origin `fetch` stays "simple" (no OPTIONS preflight) only while every
// author-set request header is CORS-safelisted. Anything outside this set makes
// the browser preflight, and a host that does not answer OPTIONS -- or does not
// echo the header in Access-Control-Allow-Headers -- then fails the request
// before it is ever made. This is what broke raw.githubusercontent.com and the
// Cupcake host: the transport was sending `Cache-Control: no-cache`.
const CORS_SAFELISTED_HEADERS = new Set([
    'accept',
    'accept-language',
    'content-language',
    'content-type',
    'range',
])

/** Fails with a useful message naming the exact header that would preflight. */
function expectNoPreflightTriggeringHeaders(headers: Record<string, string> | undefined) {
    const unsafe = Object.keys(headers ?? {}).filter((name) => !CORS_SAFELISTED_HEADERS.has(name.toLowerCase()))
    expect(unsafe, `these headers are not CORS-safelisted and force an OPTIONS preflight: ${unsafe.join(', ')}`).toEqual([])
    // Range is safelisted only for a "simple range header value": `bytes=`,
    // digits, `-`, digits. `bytes=0-511` qualifies; `bytes=0-511, 600-700` or
    // a unit other than bytes would not.
    const range = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'range')?.[1]
    if (range !== undefined) {
        expect(range).toMatch(/^bytes=\d*-\d*$/)
    }
}

function baseRow(name: string, updateURL: string, overrides: Record<string, unknown> = {}) {
    return {
        name,
        script: 'old source',
        version: '3.0',
        versionOfPlugin: '1.0.0',
        updateURL,
        enabled: true,
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        allowedIPC: [],
        ...overrides,
    }
}

function sourceFor(name: string, updateURL: string, version = '2.0.0', extraLines: string[] = []) {
    return [
        `//@name ${name}`,
        '//@api 3.0',
        `//@version ${version}`,
        `//@update-url ${updateURL}`,
        ...extraLines,
        'Risuai.log("updated")',
    ].join('\n')
}

describe('plugin update transport', () => {
    beforeEach(() => {
        runtime.db.plugins = []
        runtime.db.pluginCustomStorage = {}
        runtime.fetchNative.mockReset()
        runtime.save.mockReset().mockResolvedValue(undefined)
        runtime.loadV3Plugins.mockReset().mockResolvedValue(undefined)
    })

    test('checkPluginUpdate goes through fetchNative with a Range request, not a raw fetch', async () => {
        const url = 'https://example.com/range-plugin.js'
        runtime.db.plugins = [baseRow('Range Plugin', url)]
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Range Plugin', url), 206))

        const info = await checkPluginUpdate(runtime.db.plugins[0])

        expect(info).toEqual({ version: '2.0.0', updateURL: url })
        expect(runtime.fetchNative).toHaveBeenCalledOnce()
        const [calledUrl, args] = runtime.fetchNative.mock.calls[0]
        expect(calledUrl).toBe(url)
        expect(args.method).toBe('GET')
        expect(args.headers.Range).toBe('bytes=0-511')
        expectNoPreflightTriggeringHeaders(args.headers)
    })

    test('checkPluginUpdate retries without Range when the server rejects the Range request', async () => {
        const url = 'https://example.com/range-fallback-plugin.js'
        runtime.db.plugins = [baseRow('RangeFallback Plugin', url)]
        // Some servers answer a Range header with a 4xx instead of just
        // ignoring it and returning the full body.
        runtime.fetchNative
            .mockResolvedValueOnce(response('range not supported', 416))
            .mockResolvedValueOnce(response(sourceFor('RangeFallback Plugin', url), 200))

        const info = await checkPluginUpdate(runtime.db.plugins[0])

        expect(info).toEqual({ version: '2.0.0', updateURL: url })
        expect(runtime.fetchNative).toHaveBeenCalledTimes(2)
        expect(runtime.fetchNative.mock.calls[0][1].headers.Range).toBe('bytes=0-511')
        expect(runtime.fetchNative.mock.calls[1][1].headers.Range).toBeUndefined()
    })

    test('updatePlugin downloads through fetchNative (the same transport the check used), without Range', async () => {
        const url = 'https://example.com/transport-plugin.js'
        runtime.db.plugins = [baseRow('Transport Plugin', url)]
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Transport Plugin', url), 200))

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result).toEqual({ ok: true, version: '2.0.0' })
        expect(runtime.fetchNative).toHaveBeenCalledOnce()
        const [calledUrl, args] = runtime.fetchNative.mock.calls[0]
        expect(calledUrl).toBe(url)
        expect(args.method).toBe('GET')
        expect(args.headers.Range).toBeUndefined()
    })

    test('a successful check followed by a failed full download is reported as a download failure', async () => {
        const url = 'https://example.com/check-then-fail-plugin.js'
        runtime.db.plugins = [baseRow('CheckThenFail Plugin', url)]

        // First call simulates the Range-based check succeeding...
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('CheckThenFail Plugin', url), 206))
        const checked = await checkPluginUpdate(runtime.db.plugins[0])
        expect(checked?.version).toBe('2.0.0')

        // ...then the actual full download made by updatePlugin() fails on
        // its own, independent request.
        runtime.fetchNative.mockResolvedValueOnce(response('server error', 500))
        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result).toEqual({ ok: false, stage: 'download', code: 'http-500', detail: 'HTTP 500' })
    })

    test('updating the legacy pagefold row is rejected as a policy failure, not a generic one', async () => {
        const url = 'https://example.com/pagefold.js'
        runtime.db.plugins = [baseRow('pagefold', url, { versionOfPlugin: '0.1.0' })]
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('pagefold', url, '0.2.0'), 200))

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result).toEqual({
            ok: false,
            stage: 'policy',
            code: 'pagefold-blocked',
            detail: 'PageFold is built in and cannot be installed as a separate plugin.',
        })
        expect(runtime.save).not.toHaveBeenCalled()
    })

    test('a renamed download is rejected with a name-changed policy code', async () => {
        const url = 'https://example.com/rename-plugin.js'
        runtime.db.plugins = [baseRow('Rename Plugin', url)]
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Renamed Plugin', url), 200))

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result.ok).toBe(false)
        if (result.ok === false) {
            expect(result.stage).toBe('policy')
            expect(result.code).toBe('name-changed')
        }
        expect(runtime.save).not.toHaveBeenCalled()
    })

    test('a durable-save failure is reported distinctly and does not report success', async () => {
        const url = 'https://example.com/save-fail-plugin.js'
        runtime.db.plugins = [baseRow('SaveFail Plugin', url)]
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('SaveFail Plugin', url), 200))
        runtime.save.mockRejectedValueOnce(new Error('disk full'))

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result).toEqual({ ok: false, stage: 'save', code: 'durable-save-failed', detail: 'disk full' })
    })

    test('user arguments, enabled state, and custom storage survive a real update', async () => {
        const url = 'https://example.com/preserve-plugin.js'
        runtime.db.plugins = [baseRow('Preserve Plugin', url, {
            enabled: false,
            arguments: { endpoint: 'string' },
            realArg: { endpoint: 'https://saved.example' },
        })]
        runtime.db.pluginCustomStorage = { 'Preserve Plugin:preferences': { theme: 'dark' } }
        runtime.fetchNative.mockResolvedValueOnce(
            response(sourceFor('Preserve Plugin', url, '2.0.0', ['//@arg endpoint string']), 200),
        )

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result).toEqual({ ok: true, version: '2.0.0' })
        const installed = runtime.db.plugins[0]
        expect(installed.enabled).toBe(false)
        expect(installed.realArg).toEqual({ endpoint: 'https://saved.example' })
        expect(runtime.db.pluginCustomStorage).toEqual({ 'Preserve Plugin:preferences': { theme: 'dark' } })
    })

    // --- CORS / preflight ---------------------------------------------------

    test('no plugin fetch sends a header that would force a CORS preflight', async () => {
        const checkUrl = 'https://example.com/simple-check-plugin.js'
        const downloadUrl = 'https://example.com/simple-download-plugin.js'
        runtime.db.plugins = [
            baseRow('SimpleCheck Plugin', checkUrl),
            baseRow('SimpleDownload Plugin', downloadUrl),
        ]
        runtime.fetchNative
            .mockResolvedValueOnce(response(sourceFor('SimpleCheck Plugin', checkUrl), 206))
            .mockResolvedValueOnce(response(sourceFor('SimpleDownload Plugin', downloadUrl), 200))

        await checkPluginUpdate(runtime.db.plugins[0])
        await updatePlugin(runtime.db.plugins[1])

        expect(runtime.fetchNative).toHaveBeenCalledTimes(2)
        for (const [, args] of runtime.fetchNative.mock.calls) {
            expectNoPreflightTriggeringHeaders(args.headers)
            // The old transport sent this and it is what the live browser
            // rejected on both hosts. Freshness now rides on the fetch()
            // cache mode, which adds no author header.
            const names = Object.keys(args.headers ?? {}).map((name) => name.toLowerCase())
            expect(names).not.toContain('cache-control')
            expect(names).not.toContain('pragma')
            expect(args.cache).toBe('no-cache')
        }
    })

    test('plugin fetches ask for the server relay first, which has no CORS restriction', async () => {
        const url = 'https://example.com/proxy-first-plugin.js'
        runtime.db.plugins = [baseRow('ProxyFirst Plugin', url)]
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('ProxyFirst Plugin', url), 206))

        await checkPluginUpdate(runtime.db.plugins[0])

        expect(runtime.fetchNative.mock.calls[0][1].preferServerProxy).toBe(true)
    })

    test('a host that refuses the preflight/Range outright still completes an update check and install', async () => {
        const url = 'https://no-cors.example.com/strict-plugin.js'
        runtime.db.plugins = [baseRow('Strict Plugin', url)]

        // What the browser actually surfaces when the OPTIONS preflight is
        // answered with a non-2xx (raw.githubusercontent.com) or when the
        // requested header is not allow-listed (the Cupcake host): the fetch
        // promise REJECTS, it does not resolve with a status.
        const corsFailure = () => Promise.reject(new TypeError('Failed to fetch'))

        runtime.fetchNative
            .mockImplementationOnce(corsFailure)                                                   // ranged probe
            .mockResolvedValueOnce(response(sourceFor('Strict Plugin', url), 200))                 // plain GET check
            .mockResolvedValueOnce(response(sourceFor('Strict Plugin', url), 200))                 // download

        const info = await checkPluginUpdate(runtime.db.plugins[0])
        expect(info).toEqual({ version: '2.0.0', updateURL: url })

        // The retry after the refusal must be a plain GET carrying no Range.
        expect(runtime.fetchNative.mock.calls[1][1].headers.Range).toBeUndefined()
        expectNoPreflightTriggeringHeaders(runtime.fetchNative.mock.calls[1][1].headers)

        const result = await updatePlugin(runtime.db.plugins[0])
        expect(result).toEqual({ ok: true, version: '2.0.0' })
        expect(runtime.db.plugins[0].versionOfPlugin).toBe('2.0.0')
    })

    test('a ranged read that cuts the //@version line in half falls back to a full GET', async () => {
        const url = 'https://example.com/truncated-plugin.js'
        runtime.db.plugins = [baseRow('Truncated Plugin', url)]
        const full = sourceFor('Truncated Plugin', url, '10.0.0')
        // Cut mid-token: an unanchored, unterminated regex used to read this
        // as version "10.0" and compare it against 1.0.0 as an upgrade to the
        // wrong number.
        const truncated = full.slice(0, full.indexOf('//@version 10.0.0') + '//@version 10.0'.length)

        runtime.fetchNative
            .mockResolvedValueOnce(response(truncated, 206))
            .mockResolvedValueOnce(response(full, 200))

        const info = await checkPluginUpdate(runtime.db.plugins[0])

        expect(info).toEqual({ version: '10.0.0', updateURL: url })
        expect(runtime.fetchNative).toHaveBeenCalledTimes(2)
    })

    // --- SSRF guard on the relayed URL --------------------------------------

    test('an update URL pointing at a private host is refused before any request is made', async () => {
        const url = 'https://192.168.1.10/internal-plugin.js'
        runtime.db.plugins = [baseRow('Private Plugin', url)]

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result).toEqual({
            ok: false,
            stage: 'download',
            code: 'update-url-private-host',
            detail: 'plugin update URL points at a private or loopback host',
        })
        expect(runtime.fetchNative).not.toHaveBeenCalled()
    })

    test('a non-https update URL is refused before any request is made', async () => {
        const url = 'http://plain.example.com/plugin.js'
        runtime.db.plugins = [baseRow('Plain Plugin', url)]

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result.ok).toBe(false)
        if (result.ok === false) expect(result.code).toBe('update-url-not-https')
        expect(runtime.fetchNative).not.toHaveBeenCalled()
    })

    // --- verification -------------------------------------------------------

    test('an upstream that moves its own //@update-url verifies as a success, not a mismatch', async () => {
        const oldUrl = 'https://old.example.com/moved-plugin.js'
        const newUrl = 'https://new.example.com/moved-plugin.js'
        runtime.db.plugins = [baseRow('Moved Plugin', oldUrl)]
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Moved Plugin', newUrl), 200))

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result).toEqual({
            ok: true,
            version: '2.0.0',
            updateURLChanged: { from: oldUrl, to: newUrl },
        })
        // The install really did land, which is what made the old
        // verify/update-url-mismatch failure so misleading.
        expect(runtime.db.plugins[0].versionOfPlugin).toBe('2.0.0')
        expect(runtime.db.plugins[0].updateURL).toBe(newUrl)
    })

    test('a rename is still rejected even though the updateURL moved with it', async () => {
        const oldUrl = 'https://old.example.com/hijack-plugin.js'
        const newUrl = 'https://attacker.example.com/hijack-plugin.js'
        runtime.db.plugins = [baseRow('Hijack Plugin', oldUrl)]
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Other Plugin', newUrl), 200))

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result.ok).toBe(false)
        if (result.ok === false) {
            expect(result.stage).toBe('policy')
            expect(result.code).toBe('name-changed')
        }
        expect(runtime.db.plugins[0].updateURL).toBe(oldUrl)
    })

    // --- update cache -------------------------------------------------------

    test('a failed update does not leave a sticky cache entry behind', async () => {
        const url = 'https://example.com/sticky-plugin.js'
        runtime.db.plugins = [baseRow('Sticky Plugin', url)]

        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Sticky Plugin', url), 206))
        expect(await checkPluginUpdate(runtime.db.plugins[0])).toEqual({ version: '2.0.0', updateURL: url })

        runtime.fetchNative.mockResolvedValueOnce(response('server error', 500))
        expect(await updatePlugin(runtime.db.plugins[0])).toEqual({
            ok: false, stage: 'download', code: 'http-500', detail: 'HTTP 500',
        })

        // Before the fix this returned the cached "2.0.0 available" answer
        // without issuing a request, so the `+` stayed up and kept failing for
        // the lifetime of the page. It must go back to the network instead.
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Sticky Plugin', url, '1.0.0'), 206))
        const recheck = await checkPluginUpdate(runtime.db.plugins[0])

        expect(runtime.fetchNative).toHaveBeenCalledTimes(3)
        expect(recheck).toBeUndefined()
    })

    test('a successful check is reused only while it is still fresh and still newer', async () => {
        const url = 'https://example.com/ttl-plugin.js'
        runtime.db.plugins = [baseRow('TTL Plugin', url)]
        // A fresh Response per call: a Response body can only be read once.
        runtime.fetchNative.mockImplementation(async () => response(sourceFor('TTL Plugin', url), 206))

        expect(await checkPluginUpdate(runtime.db.plugins[0])).toEqual({ version: '2.0.0', updateURL: url })
        // Second call within the TTL is served from the cache.
        expect(await checkPluginUpdate(runtime.db.plugins[0])).toEqual({ version: '2.0.0', updateURL: url })
        expect(runtime.fetchNative).toHaveBeenCalledOnce()

        vi.useFakeTimers()
        try {
            vi.setSystemTime(Date.now() + 6 * 60 * 1000)
            expect(await checkPluginUpdate(runtime.db.plugins[0])).toEqual({ version: '2.0.0', updateURL: url })
        } finally {
            vi.useRealTimers()
        }
        expect(runtime.fetchNative).toHaveBeenCalledTimes(2)
    })
})
