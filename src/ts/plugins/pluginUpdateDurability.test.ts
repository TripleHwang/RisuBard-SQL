import { beforeEach, describe, expect, test, vi } from 'vitest'

// A plugin update is only finished when it is ON DISK. On the standalone Node
// build the app boots in `metadata-first` mode, which never calls saveDb() --
// the one place that used to assign `requestImmediateSaveImpl` -- so
// `requestImmediateSave({ rejectOnFailure: true })` was a no-op that could
// never reject. importPlugin() awaited it as its durable-save step and
// reported success; the row only reached SQL later, if the idle compatibility
// audit happened to notice it before the user reloaded. That is the
// "the version changed, then the old one came back" report.
//
// These tests drive the REAL importPlugin()/updatePlugin() against a fake
// disk, and check the state after a simulated RELOAD -- i.e. rebuilt from what
// the persistence layer actually committed, never from the in-memory object
// the update mutated.

const runtime = vi.hoisted(() => ({
    /** What has actually been committed. A reload restores from here. */
    disk: { plugins: [] as any[] },
    db: {
        plugins: [] as any[],
        pluginCustomStorage: {} as Record<string, unknown>,
        allowV2Plugin: false,
    },
    fetchNative: vi.fn(),
    save: vi.fn(),
    loadV3Plugins: vi.fn(),
    hydrationReady: true,
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
vi.mock('../storage/sql/rootWritePolicy', () => ({
    isDeferredRootHydrationReady: () => runtime.hydrationReady,
}))

import { updatePlugin } from './plugins.svelte'

function response(body: string, status: number): Response {
    return new Response(body, { status })
}

function baseRow(name: string, updateURL: string) {
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
    }
}

function sourceFor(name: string, updateURL: string, version = '2.0.0') {
    return [
        `//@name ${name}`,
        '//@api 3.0',
        `//@version ${version}`,
        `//@update-url ${updateURL}`,
        'Risuai.log("updated")',
    ].join('\n')
}

/** A persistence layer that really writes. */
function workingPersistence() {
    return runtime.save.mockImplementation(async () => {
        runtime.disk.plugins = JSON.parse(JSON.stringify(runtime.db.plugins))
    })
}

/**
 * What the app actually did on the metadata-first build: nothing at all, and
 * resolved anyway. `requestImmediateSaveImpl` is initialised to a bare
 * `() => {}` and only saveDb() ever assigned it, so on a build that never
 * calls saveDb() every awaited "force a save now" resolved without writing.
 */
function silentNoOpPersistence() {
    return runtime.save.mockImplementation(async () => { /* resolves, writes nothing */ })
}

/**
 * The fixed default (see requestImmediateSaveImpl in globalApi.svelte.ts): a
 * caller that demands durability and gets no persistence runtime is told so
 * instead of being handed a false success.
 */
function absentPersistence() {
    return runtime.save.mockImplementation(async (options?: { rejectOnFailure?: boolean }) => {
        if (options?.rejectOnFailure) {
            throw new Error('No persistence runtime is active, so the state could not be saved immediately')
        }
    })
}

/** Rebuilds the in-memory database from what was actually committed. */
function reload() {
    runtime.db.plugins = JSON.parse(JSON.stringify(runtime.disk.plugins))
}

describe('plugin update durability', () => {
    beforeEach(() => {
        runtime.db.plugins = []
        runtime.db.pluginCustomStorage = {}
        runtime.disk.plugins = []
        runtime.hydrationReady = true
        runtime.fetchNative.mockReset()
        runtime.save.mockReset()
        runtime.loadV3Plugins.mockReset().mockResolvedValue(undefined)
    })

    test('an update reported as successful is still there after a reload', async () => {
        const url = 'https://example.com/durable-plugin.js'
        runtime.db.plugins = [baseRow('Durable Plugin', url)]
        runtime.disk.plugins = JSON.parse(JSON.stringify(runtime.db.plugins))
        workingPersistence()
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Durable Plugin', url), 200))

        const result = await updatePlugin(runtime.db.plugins[0])
        expect(result).toEqual({ ok: true, version: '2.0.0' })

        // The durable-save step must have run BEFORE success was reported,
        // and must have been the kind that reports its own failure.
        expect(runtime.save).toHaveBeenCalledWith({ rejectOnFailure: true })

        reload()
        expect(runtime.db.plugins).toHaveLength(1)
        expect(runtime.db.plugins[0].versionOfPlugin).toBe('2.0.0')
        expect(runtime.db.plugins[0].script).toContain('//@version 2.0.0')
    })

    test('a persistence layer that writes nothing cannot produce an ok:true result', async () => {
        const url = 'https://example.com/absent-persistence-plugin.js'
        runtime.db.plugins = [baseRow('Absent Plugin', url)]
        runtime.disk.plugins = JSON.parse(JSON.stringify(runtime.db.plugins))
        absentPersistence()
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Absent Plugin', url), 200))

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result.ok).toBe(false)
        if (result.ok === false) {
            expect(result.stage).toBe('save')
            expect(result.code).toBe('durable-save-failed')
        }
        // And the reload agrees with the report: nothing was persisted.
        reload()
        expect(runtime.db.plugins[0].versionOfPlugin).toBe('1.0.0')
    })

    test('the old silent no-op is what made the report and the disk disagree', async () => {
        // Pinned as a regression witness: with a save layer that resolves
        // without writing, the update still claims ok:true while the reload
        // brings the old version back. Nothing may reintroduce that default --
        // see absentPersistence() above for the shape the real one now has.
        const url = 'https://example.com/silent-noop-plugin.js'
        runtime.db.plugins = [baseRow('SilentNoOp Plugin', url)]
        runtime.disk.plugins = JSON.parse(JSON.stringify(runtime.db.plugins))
        silentNoOpPersistence()
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('SilentNoOp Plugin', url), 200))

        const result = await updatePlugin(runtime.db.plugins[0])
        expect(result).toEqual({ ok: true, version: '2.0.0' })

        reload()
        expect(runtime.db.plugins[0].versionOfPlugin).toBe('1.0.0')
    })

    test('an update is refused while the deferred root-write gate is still closed', async () => {
        // planRootWrite() SKIPS a deferred key before hydration lands, and the
        // skip is silent: the dirty mark is acknowledged as if it committed.
        // Installing into that window would report a success the database
        // never received.
        const url = 'https://example.com/gated-plugin.js'
        runtime.db.plugins = [baseRow('Gated Plugin', url)]
        runtime.disk.plugins = JSON.parse(JSON.stringify(runtime.db.plugins))
        workingPersistence()
        runtime.hydrationReady = false
        runtime.fetchNative.mockResolvedValueOnce(response(sourceFor('Gated Plugin', url), 200))

        const result = await updatePlugin(runtime.db.plugins[0])

        expect(result.ok).toBe(false)
        if (result.ok === false) {
            expect(result.stage).toBe('save')
            expect(result.code).toBe('plugins-not-hydrated')
        }
        expect(runtime.save).not.toHaveBeenCalled()
        reload()
        expect(runtime.db.plugins[0].versionOfPlugin).toBe('1.0.0')
    })
})
