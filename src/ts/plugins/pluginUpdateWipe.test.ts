import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const runtime = vi.hoisted(() => ({
    db: {
        plugins: [] as any[],
        pluginCustomStorage: {} as Record<string, unknown>,
        allowV2Plugin: false,
    },
    save: vi.fn(),
    fetchNative: vi.fn(),
    loadV3Plugins: vi.fn(),
    transpile: vi.fn(),
    safety: vi.fn(async () => ({ isSafe: true, errors: [] as string[] })),
    startupReady: vi.fn(() => true),
}))

vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => runtime.db,
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
    getCurrentCharacter: vi.fn(),
    markTrustedFullReplacement: (v: any) => v,
    createBotPresetTemplate: () => ({ id: 'preset-template', name: 'Default' }),
}))
vi.mock('../alert', () => ({ alertConfirm: vi.fn(), alertError: vi.fn(), alertPluginConfirm: vi.fn() }))
vi.mock('../util', () => ({ selectSingleFile: vi.fn(), sleep: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({
    fetchNative: runtime.fetchNative, globalFetch: vi.fn(), readImage: vi.fn(),
    requestImmediateSave: runtime.save, saveAsset: vi.fn(), toGetter: vi.fn(),
    forageStorage: { realStorage: null },
}))
vi.mock('../storage/chatStorage', () => ({ chatToStub: (chat: any) => chat }))
vi.mock('../stores.svelte', () => ({
    DBState: { db: runtime.db }, hotReloading: [], pluginAlertModalStore: { open: false, errors: [] }, selectedCharID: {},
}))
vi.mock('../startupReadiness', () => ({
    isStartupMutationReady: () => runtime.startupReady(),
}))
vi.mock('./pluginSafety', () => ({ checkCodeSafety: runtime.safety }))
vi.mock('./pluginSafeClass', () => ({ SafeDocument: {}, SafeIdbFactory: {}, SafeLocalStorage: class {} }))
vi.mock('./apiV3/v3.svelte', () => ({ loadV3Plugins: runtime.loadV3Plugins }))
vi.mock('./apiV3/transpiler', () => ({ pluginCodeTranspiler: runtime.transpile }))
vi.mock('../builtin/pagefold', () => ({
    PAGEFOLD_PLUGIN_NAME: 'pagefold',
    loadBuiltInPageFoldPlugin: vi.fn(async () => ({ name: 'pagefold', enabled: true, version: '3.0' })),
}))

import { updatePlugin } from './plugins.svelte'
import { runPluginUpdate, PluginUpdateRejection, type PluginUpdateFailureStage } from './pluginUpdate'
import { buildSqlDirtyCommit } from '../storage/sql/sqlDirtyCommit'
import { applySqliteCommit } from '../storage/sql/sqliteCommit'
import {
    armDeferredRootWriteGate,
    DEFERRED_ROOT_KEYS,
    isDeferredRootHydrationReady,
    markDeferredRootHydrationApplied,
    NEVER_IMPLICITLY_DELETE,
    planRootWrite,
    requestRootDeletion,
    resetDeferredRootWriteGateForTesting,
    resetRootWriteWarningsForTesting,
} from '../storage/sql/rootWritePolicy'
import { RisuSaveDecoder } from '../storage/risuSave'

function installedFixture() {
    return [
        {
            name: 'Alpha', script: 'alpha v1', version: '3.0', versionOfPlugin: '1.0.0',
            updateURL: 'https://example.com/alpha.js', enabled: true,
            arguments: {}, realArg: {}, customLink: [], argMeta: {}, allowedIPC: [],
        },
        {
            name: 'Beta', script: 'beta v1', version: '3.0', versionOfPlugin: '1.0.0',
            updateURL: 'https://example.com/beta.js', enabled: true,
            arguments: {}, realArg: {}, customLink: [], argMeta: {}, allowedIPC: [],
        },
        {
            name: 'Gamma', script: 'gamma v1', version: '3.0', versionOfPlugin: '1.0.0',
            updateURL: 'https://example.com/gamma.js', enabled: false,
            arguments: {}, realArg: {}, customLink: [], argMeta: {}, allowedIPC: [],
        },
    ]
}

function textResponse(body: string, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
    } as unknown as Response
}

// Every rejection the v0.3.2.8 importer can raise, one per stage/code pair
// that `rejectImport()` is wired to in plugins.svelte.ts.
const REJECTION_SOURCES: Array<{ label: string, source: string }> = [
    { label: 'parse/name-missing', source: '//@api 3.0\n//@version 2.0.0\nRisuai.log(1)' },
    { label: 'parse/display-name-missing', source: '//@name Beta\n//@display-name \n//@api 3.0\n//@version 2.0.0' },
    { label: 'parse/link-not-https', source: '//@name Beta\n//@link http://x.example\n//@api 3.0\n//@version 2.0.0' },
    { label: 'parse/arg-type-unknown', source: '//@name Beta\n//@arg foo bool\n//@api 3.0\n//@version 2.0.0' },
    { label: 'parse/update-url-invalid', source: '//@name Beta\n//@update-url not-a-url\n//@api 3.0\n//@version 2.0.0' },
    { label: 'parse/update-url-not-https', source: '//@name Beta\n//@update-url http://example.com/beta.js\n//@api 3.0\n//@version 2.0.0' },
    { label: 'policy/name-changed', source: '//@name Renamed\n//@api 3.0\n//@version 2.0.0\n//@update-url https://example.com/beta.js' },
    { label: 'policy/pagefold-blocked', source: '//@name pagefold\n//@api 3.0\n//@version 2.0.0\n//@update-url https://example.com/beta.js' },
    { label: 'parse/version-too-low', source: '//@name Beta\n//@api 3.0\n//@version 0.0.0\n//@update-url https://example.com/beta.js' },
]

describe('v0.3.2.8 plugin update failure paths must never shorten or empty db.plugins', () => {
    beforeEach(() => {
        runtime.db.plugins = installedFixture()
        runtime.db.pluginCustomStorage = { 'Beta:prefs': { a: 1 } }
        runtime.save.mockReset().mockResolvedValue(undefined)
        runtime.loadV3Plugins.mockReset().mockResolvedValue(undefined)
        runtime.safety.mockReset().mockResolvedValue({ isSafe: true, errors: [] })
        runtime.transpile.mockReset()
        runtime.fetchNative.mockReset()
        runtime.startupReady.mockReset().mockReturnValue(true)
    })

    test.each(REJECTION_SOURCES)('real update path, importer rejects at $label: list unchanged', async ({ source }) => {
        const before = JSON.parse(JSON.stringify(runtime.db.plugins))
        runtime.fetchNative.mockResolvedValue(textResponse(source))

        const result = await updatePlugin({ name: 'Beta', updateURL: 'https://example.com/beta.js' } as any)

        expect(result.ok).toBe(false)
        expect(runtime.db.plugins).toHaveLength(3)
        expect(runtime.db.plugins).toEqual(before)
    })

    test('durable-save rejection leaves every row in place (only the target row is touched)', async () => {
        const source = [
            '//@name Beta', '//@api 3.0', '//@version 2.0.0',
            '//@update-url https://example.com/beta.js', 'Risuai.log("v2")',
        ].join('\n')
        runtime.fetchNative.mockResolvedValue(textResponse(source))
        runtime.save.mockRejectedValue(new Error('Immediate save did not persist the requested state'))

        const result = await updatePlugin({ name: 'Beta', updateURL: 'https://example.com/beta.js' } as any)

        expect(result).toMatchObject({ ok: false, stage: 'save', code: 'durable-save-failed' })
        expect(runtime.db.plugins).toHaveLength(3)
        expect(runtime.db.plugins.map(p => p.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    })

    test('a synthetic importer that throws at every stage never mutates the list', async () => {
        const stages: PluginUpdateFailureStage[] = ['download', 'parse', 'policy', 'save', 'verify']
        for (const stage of stages) {
            runtime.db.plugins = installedFixture()
            const before = JSON.parse(JSON.stringify(runtime.db.plugins))
            const result = await runPluginUpdate(
                { name: 'Beta', updateURL: 'https://example.com/beta.js' },
                {
                    fetcher: async () => textResponse('//@name Beta\n//@version 9.9.9'),
                    importer: async () => { throw new PluginUpdateRejection(stage, `synthetic-${stage}`) },
                    readInstalled: (name) => runtime.db.plugins.find((p) => p.name === name),
                },
            )
            expect(result).toMatchObject({ ok: false, stage, code: `synthetic-${stage}` })
            expect(runtime.db.plugins).toEqual(before)
        }
    })

    test('an importer that throws a non-rejection error also leaves the list intact', async () => {
        const before = JSON.parse(JSON.stringify(runtime.db.plugins))
        const result = await runPluginUpdate(
            { name: 'Beta', updateURL: 'https://example.com/beta.js' },
            {
                fetcher: async () => textResponse('//@name Beta\n//@version 9.9.9'),
                importer: async () => { throw new TypeError('boom') },
                readInstalled: (name) => runtime.db.plugins.find((p) => p.name === name),
            },
        )
        expect(result).toMatchObject({ ok: false, stage: 'save', code: 'importer-threw' })
        expect(runtime.db.plugins).toEqual(before)
    })

    // ── importPlugin's own pre-hydration and missing-target guards ──────────

    test('an import before deferred hydration refuses instead of materialising db.plugins = []', async () => {
        delete (runtime.db as { plugins?: unknown[] }).plugins
        runtime.startupReady.mockReturnValue(false)
        const source = [
            '//@name Beta', '//@api 3.0', '//@version 2.0.0',
            '//@update-url https://example.com/beta.js', 'Risuai.log("v2")',
        ].join('\n')
        runtime.fetchNative.mockResolvedValue(textResponse(source))

        const result = await updatePlugin({ name: 'Beta', updateURL: 'https://example.com/beta.js' } as any)

        expect(result).toMatchObject({ ok: false, stage: 'save', code: 'plugins-not-hydrated' })
        // The wipe primitive is exactly this: an empty list published over a
        // key that had simply not loaded yet.
        expect(runtime.db.plugins).toBeUndefined()
        expect(runtime.save).not.toHaveBeenCalled()
    })

    test('updating a plugin that is not installed is an explicit rejection, not a silent no-op', async () => {
        runtime.db.plugins = installedFixture().filter((plugin) => plugin.name !== 'Beta')
        const before = JSON.parse(JSON.stringify(runtime.db.plugins))
        const source = [
            '//@name Beta', '//@api 3.0', '//@version 2.0.0',
            '//@update-url https://example.com/beta.js', 'Risuai.log("v2")',
        ].join('\n')
        runtime.fetchNative.mockResolvedValue(textResponse(source))

        const result = await updatePlugin({ name: 'Beta', updateURL: 'https://example.com/beta.js' } as any)

        expect(result).toMatchObject({ ok: false, stage: 'policy', code: 'update-target-missing' })
        expect(runtime.db.plugins).toEqual(before)
        expect(runtime.save).not.toHaveBeenCalled()
    })
})

// ── The actual wipe primitive, isolated from the plugin update path ─────────

const emptyDirty = {
    rootKeys: [] as string[], characterIds: [] as string[], chats: [] as any[],
    messages: [] as any[], messageManifestChatIds: [] as string[], messageDeletes: [] as any[],
    pluginStorageKeys: [] as string[], presetIds: [] as string[],
}

function dirtyRoots(...keys: string[]) {
    return { ...emptyDirty, rootKeys: keys }
}

/** Renders a commit the way NodeSqliteStorage does, so the real SQL is visible. */
async function commitStatements(commit: ReturnType<typeof buildSqlDirtyCommit>) {
    const statements: { sql: string, bind: unknown[] }[] = []
    await applySqliteCommit(commit, (sql, bind = []) => { statements.push({ sql, bind }) })
    return statements
}

/** Hydration has landed: deferred keys are writable and reflect the server. */
function hydrated(keys: string[] = [...DEFERRED_ROOT_KEYS]) {
    armDeferredRootWriteGate()
    markDeferredRootHydrationApplied(keys)
}

describe('root-key commit planning cannot implicitly delete user collections', () => {
    beforeEach(() => {
        resetDeferredRootWriteGateForTesting()
        resetRootWriteWarningsForTesting()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
        vi.restoreAllMocks()
        resetDeferredRootWriteGateForTesting()
    })

    test('an absent plugins key produces NO delete, even once hydration has landed', () => {
        hydrated()
        const database = { characters: [], botPresets: [] } as any // no `plugins` key at all
        const commit = buildSqlDirtyCommit(database, dirtyRoots('plugins'), 1)
        expect(commit.root.deletes).toEqual([])
        expect(commit.root.upserts).toEqual([])
    })

    test('the ON DELETE CASCADE can never fire from the implicit path', async () => {
        hydrated()
        // Every protected key, all missing at once - the exact shape of a
        // pre-hydration snapshot diff seen by the audit loop.
        const database = { characters: [], botPresets: [] } as any
        const commit = buildSqlDirtyCommit(database, dirtyRoots(...NEVER_IMPLICITLY_DELETE), 1)
        const statements = await commitStatements(commit)
        expect(statements.filter((statement) => /DELETE FROM system_settings/i.test(statement.sql))).toEqual([])
    })

    test('every protected key is refused individually, and the list covers the deferred set', () => {
        hydrated()
        for (const key of NEVER_IMPLICITLY_DELETE) {
            const plan = planRootWrite({}, key)
            expect(plan, key).toEqual({ action: 'skip', reason: 'protected-key-absent' })
        }
        // The reported wipe was a deferred key. Every deferred key holds a
        // user-owned collection, so none of them may be implicitly deletable.
        for (const key of DEFERRED_ROOT_KEYS) expect(NEVER_IMPLICITLY_DELETE.has(key), key).toBe(true)
    })

    test('an unprotected root key still deletes normally when it goes missing', () => {
        hydrated()
        const commit = buildSqlDirtyCommit({ characters: [] } as any, dirtyRoots('username'), 1)
        expect(commit.root.deletes).toEqual(['username'])
    })

    test('an explicit deletion request is honoured exactly once', () => {
        hydrated()
        requestRootDeletion('plugins')
        expect(planRootWrite({}, 'plugins')).toEqual({ action: 'delete' })
        expect(planRootWrite({}, 'plugins')).toEqual({ action: 'skip', reason: 'protected-key-absent' })
    })

    test('a function-valued root key is treated as missing, not upserted', () => {
        hydrated()
        const commit = buildSqlDirtyCommit({ plugins: () => {} } as any, dirtyRoots('plugins'), 1)
        expect(commit.root.upserts).toEqual([])
        expect(commit.root.deletes).toEqual([])
    })

    test('a populated plugins list still upserts normally', () => {
        hydrated()
        const database = { characters: [], botPresets: [], plugins: installedFixture() } as any
        const commit = buildSqlDirtyCommit(database, dirtyRoots('plugins'), 1)
        expect(commit.root.deletes).toEqual([])
        expect((commit.root.upserts[0].value as any[])).toHaveLength(3)
    })
})

describe('"not loaded yet" and "genuinely emptied" are different states', () => {
    beforeEach(() => {
        resetDeferredRootWriteGateForTesting()
        resetRootWriteWarningsForTesting()
        vi.spyOn(console, 'warn').mockImplementation(() => {})
    })
    afterEach(() => {
        vi.restoreAllMocks()
        resetDeferredRootWriteGateForTesting()
    })

    test('pre-hydration: an undefined plugins key produces no plugin write at all', async () => {
        armDeferredRootWriteGate()
        expect(isDeferredRootHydrationReady()).toBe(false)
        const commit = buildSqlDirtyCommit({ characters: [] } as any, dirtyRoots('plugins'), 1)
        expect(commit.root.deletes).toEqual([])
        expect(commit.root.upserts).toEqual([])
        expect(await commitStatements(commit)).toEqual([])
    })

    test('pre-hydration: even a materialised empty list produces no plugin write at all', async () => {
        armDeferredRootWriteGate()
        // This is what `db.plugins ??= []` (or the legacy checkNullish defaults
        // pass) leaves behind when it runs before deferred hydration. Upserting
        // it is just as destructive as deleting: sqliteCommit replaces the
        // whole node set for the key.
        const commit = buildSqlDirtyCommit({ characters: [], plugins: [] } as any, dirtyRoots('plugins'), 1)
        expect(commit.root.upserts).toEqual([])
        expect(commit.root.deletes).toEqual([])
        expect(await commitStatements(commit)).toEqual([])
    })

    test('post-hydration: a genuinely emptied list persists as an empty upsert', async () => {
        hydrated(['plugins'])
        expect(isDeferredRootHydrationReady()).toBe(true)
        const commit = buildSqlDirtyCommit({ characters: [], plugins: [] } as any, dirtyRoots('plugins'), 1)
        expect(commit.root.upserts).toEqual([{ key: 'plugins', value: [] }])
        expect(commit.root.deletes).toEqual([])
        const statements = await commitStatements(commit)
        expect(statements.some((statement) => /INSERT INTO system_settings/i.test(statement.sql))).toBe(true)
        expect(statements.filter((statement) => /DELETE FROM system_settings/i.test(statement.sql))).toEqual([])
    })

    test('a deferred key the server has never stored is still writable after hydration', () => {
        // First-ever plugin install: hydration returned no `plugins` row, so a
        // per-key gate would make this write impossible forever.
        hydrated([])
        const commit = buildSqlDirtyCommit(
            { characters: [], plugins: installedFixture() } as any, dirtyRoots('plugins'), 1,
        )
        expect(commit.root.upserts).toHaveLength(1)
    })

    test('backends that never defer anything are always ready', () => {
        expect(isDeferredRootHydrationReady()).toBe(true)
        const commit = buildSqlDirtyCommit(
            { characters: [], plugins: installedFixture() } as any, dirtyRoots('plugins'), 1,
        )
        expect(commit.root.upserts).toHaveLength(1)
    })
})

describe('the client deferred-key list is the server list, not a copy of it', () => {
    test('rootWritePolicy imports the shared module that relational-sqlite.cjs requires', () => {
        const serverSource = readFileSync(
            resolve(process.cwd(), 'server/node/relational-sqlite.cjs'),
            'utf8',
        )
        expect(serverSource).toContain("require('./deferredBootstrapKeys.cjs')")
        // A re-introduced literal on either side is the drift this guards against.
        expect(serverSource).not.toMatch(/DEFERRED_BOOTSTRAP_KEYS\s*=\s*new Set\(\[/)

        const shared = readFileSync(
            resolve(process.cwd(), 'server/node/deferredBootstrapKeys.cjs'),
            'utf8',
        )
        for (const key of DEFERRED_ROOT_KEYS) expect(shared).toContain(`'${key}'`)
        expect(DEFERRED_ROOT_KEYS.has('plugins')).toBe(true)
    })
})

// ── risuSave: a failed domain block must not silently vanish ────────────────

function saveBlock(type: number, name: string, raw: string): Uint8Array {
    const nameBytes = new TextEncoder().encode(name)
    const content = new TextEncoder().encode(raw)
    const block = new Uint8Array(2 + 1 + nameBytes.length + 4 + content.length)
    block[0] = type
    block[1] = 0
    block[2] = nameBytes.length
    block.set(nameBytes, 3)
    new DataView(block.buffer).setUint32(3 + nameBytes.length, content.length, true)
    block.set(content, 3 + nameBytes.length + 4)
    return block
}

function risuSave(...blocks: Uint8Array[]): Uint8Array {
    const header = new TextEncoder().encode('RISUSAVE\0')
    const result = new Uint8Array(header.length + blocks.reduce((size, block) => size + block.length, 0))
    result.set(header)
    let offset = header.length
    for (const block of blocks) {
        result.set(block, offset)
        offset += block.length
    }
    return result
}

describe('RisuSave decode surfaces domain block failures instead of dropping the domain', () => {
    const ROOT = 1, MODULES = 5, PLUGINS = 9, PLUGIN_STORAGE = 11, CONFIG = 0

    beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}) })
    afterEach(() => { vi.restoreAllMocks() })

    test.each([
        ['plugins', PLUGINS],
        ['modules', MODULES],
        ['pluginCustomStorage', PLUGIN_STORAGE],
    ])('a corrupt %s block rejects the decode', async (domain, type) => {
        const source = risuSave(
            saveBlock(ROOT, 'root', JSON.stringify({ username: 'compat' })),
            saveBlock(type, domain, '{not json'),
        )
        await expect(new RisuSaveDecoder().decode(source)).rejects.toThrow(
            new RegExp(`Failed to decode the "${domain}" block`),
        )
    })

    test('the old behaviour - decoding "successfully" with the domain undefined - is gone', async () => {
        const source = risuSave(
            saveBlock(ROOT, 'root', JSON.stringify({ username: 'compat' })),
            saveBlock(PLUGINS, 'plugins', '{not json'),
        )
        // An undefined `db.plugins` is exactly what feeds the cascading delete
        // primitive above, so a resolved decode here would be the bug.
        await expect(new RisuSaveDecoder().decode(source)).rejects.toThrow()
    })

    test('an unrelated block type is still tolerated', async () => {
        const source = risuSave(
            saveBlock(ROOT, 'root', JSON.stringify({ username: 'compat' })),
            saveBlock(CONFIG, 'config', '{not json'),
            saveBlock(PLUGINS, 'plugins', JSON.stringify([{ name: 'Alpha' }])),
        )
        const decoded = await new RisuSaveDecoder().decode(source)
        expect(decoded.plugins).toEqual([{ name: 'Alpha' }])
    })

    test('a healthy save still decodes its plugin domains', async () => {
        const source = risuSave(
            saveBlock(ROOT, 'root', JSON.stringify({ username: 'compat' })),
            saveBlock(PLUGINS, 'plugins', JSON.stringify(installedFixture())),
            saveBlock(PLUGIN_STORAGE, 'pluginStorage', JSON.stringify({ 'Beta:prefs': { a: 1 } })),
        )
        const decoded = await new RisuSaveDecoder().decode(source)
        expect(decoded.plugins).toHaveLength(3)
        expect(decoded.pluginCustomStorage).toEqual({ 'Beta:prefs': { a: 1 } })
    })
})

// ── globalApi rebase: excluded root keys must all have a restore branch ─────

describe('the rebase path restores every root key it excluded', () => {
    const source = readFileSync(
        resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'),
        'utf8',
    )
    const rebase = source.slice(
        source.indexOf('async function rebaseTrackedLocalChangesOnLatestServerDb'),
        source.indexOf('async function persistTrackedChanges'),
    )

    test('the rebase function is still where this suite thinks it is', () => {
        expect(rebase).toContain('setDatabase(mergedDb)')
    })

    test.each([
        ['botPresets', 'toSave.botPreset'],
        ['modules', 'toSave.modules'],
        ['plugins', 'toSave.plugins'],
        ['pluginCustomStorage', 'toSave.pluginCustomStorage'],
    ])('%s is excluded from the blanket copy AND restored under %s', (key, guard) => {
        expect(rebase).toContain(`key !== '${key}'`)
        const restore = rebase.indexOf(`mergedDb.${key} = safeStructuredClone(localDb.${key})`)
        expect(restore, `${key} has no restore branch`).toBeGreaterThan(-1)
        expect(rebase.lastIndexOf(`if (${guard})`, restore)).toBeGreaterThan(-1)
        // The restore has to happen before the merged graph is published.
        expect(restore).toBeLessThan(rebase.lastIndexOf('setDatabase(mergedDb)'))
    })
})
