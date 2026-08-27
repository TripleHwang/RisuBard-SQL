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
        expect(args.headers.Range).toBe('bytes=0-512')
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
        expect(runtime.fetchNative.mock.calls[0][1].headers.Range).toBe('bytes=0-512')
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
})
