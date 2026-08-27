import { beforeEach, describe, expect, test, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
    db: {
        plugins: [] as any[],
        pluginCustomStorage: {} as Record<string, unknown>,
        allowV2Plugin: false,
    },
    save: vi.fn(),
    loadV2Plugins: vi.fn(),
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
    fetchNative: vi.fn(), globalFetch: vi.fn(), readImage: vi.fn(),
    requestImmediateSave: runtime.save, saveAsset: vi.fn(), toGetter: vi.fn(),
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

import { importPlugin } from './plugins.svelte'
import { PluginUpdateRejection } from './pluginUpdate'
import { checkCodeSafety } from './pluginSafety'

const updatedSource = [
    '//@name Test Plugin',
    '//@api 3.0',
    '//@version 2.0.0',
    '//@update-url https://example.com/plugin.js',
    '//@arg endpoint string',
    '//@arg retries int',
    '//@arg newOption string',
    'Risuai.log("updated")',
].join('\n')

describe('plugin import updates', () => {
    beforeEach(() => {
        runtime.db.plugins = [{
            name: 'Test Plugin',
            script: 'old source',
            version: '3.0',
            versionOfPlugin: '1.0.0',
            updateURL: 'https://example.com/plugin.js',
            enabled: false,
            arguments: { endpoint: 'string', retries: 'int', removed: 'string' },
            realArg: { endpoint: 'https://saved.example', retries: 4, removed: 'discard me' },
            customLink: [],
            argMeta: {},
            allowedIPC: [],
        }]
        runtime.db.pluginCustomStorage = { 'Test Plugin:preferences': { theme: 'dark' } }
        runtime.save.mockReset().mockResolvedValue(undefined)
        runtime.loadV2Plugins.mockReset().mockResolvedValue(undefined)
        runtime.loadV3Plugins.mockReset().mockResolvedValue(undefined)
    })

    test('real update import refreshes manifest while preserving compatible user state before reload', async () => {
        const order: string[] = []
        runtime.save.mockImplementation(async () => { order.push('save') })
        runtime.loadV3Plugins.mockImplementation(async () => { order.push('reload') })

        await importPlugin(updatedSource, { isUpdate: true, originalPluginName: 'Test Plugin' })

        const installed = runtime.db.plugins[0]
        expect(installed.script).toBe(updatedSource)
        expect(installed.versionOfPlugin).toBe('2.0.0')
        expect(installed.enabled).toBe(false)
        expect(installed.realArg).toEqual({
            endpoint: 'https://saved.example',
            retries: 4,
            newOption: '',
        })
        expect(runtime.db.pluginCustomStorage).toEqual({ 'Test Plugin:preferences': { theme: 'dark' } })
        expect(order).toEqual(['save', 'reload'])
    })

    test('rejects a pagefold update with a PluginUpdateRejection instead of dying in a warn-and-return', async () => {
        runtime.db.plugins = [{
            name: 'pagefold',
            script: 'legacy pagefold source',
            version: '3.0',
            versionOfPlugin: '0.1.0',
            updateURL: 'https://example.com/pagefold.js',
            enabled: true,
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
            allowedIPC: [],
        }]
        const pagefoldSource = [
            '//@name pagefold',
            '//@api 3.0',
            '//@version 0.2.0',
            '//@update-url https://example.com/pagefold.js',
            'Risuai.log("updated")',
        ].join('\n')

        let caught: unknown
        try {
            await importPlugin(pagefoldSource, { isUpdate: true, originalPluginName: 'pagefold' })
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(PluginUpdateRejection)
        expect((caught as PluginUpdateRejection).stage).toBe('policy')
        expect((caught as PluginUpdateRejection).code).toBe('pagefold-blocked')
        expect(runtime.save).not.toHaveBeenCalled()
    })

    test('rejects a renamed update with a name-changed PluginUpdateRejection', async () => {
        const renamedSource = [
            '//@name Renamed Plugin',
            '//@api 3.0',
            '//@version 2.0.0',
            '//@update-url https://example.com/plugin.js',
            'Risuai.log("updated")',
        ].join('\n')

        let caught: unknown
        try {
            await importPlugin(renamedSource, { isUpdate: true, originalPluginName: 'Test Plugin' })
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(PluginUpdateRejection)
        expect((caught as PluginUpdateRejection).stage).toBe('policy')
        expect((caught as PluginUpdateRejection).code).toBe('name-changed')
        expect(runtime.save).not.toHaveBeenCalled()
    })

    test('rejects an unsafe API 2.1 update with a policy PluginUpdateRejection instead of the interactive review modal', async () => {
        vi.mocked(checkCodeSafety).mockResolvedValueOnce({ isSafe: false, errors: ['eval() is not allowed'] } as any)
        const unsafeSource = [
            '//@name Test Plugin',
            '//@api 2.1',
            '//@version 2.0.0',
            '//@update-url https://example.com/plugin.js',
            'eval("danger")',
        ].join('\n')

        let caught: unknown
        try {
            await importPlugin(unsafeSource, { isUpdate: true, originalPluginName: 'Test Plugin' })
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(PluginUpdateRejection)
        expect((caught as PluginUpdateRejection).stage).toBe('policy')
        expect((caught as PluginUpdateRejection).code).toBe('unsafe-code-rejected')
        expect(runtime.save).not.toHaveBeenCalled()
    })

    test('rejects malformed version metadata with a parse-stage PluginUpdateRejection', async () => {
        const tooLowVersionSource = [
            '//@name Test Plugin',
            '//@api 3.0',
            '//@version 0.0.0',
            '//@update-url https://example.com/plugin.js',
            'Risuai.log("updated")',
        ].join('\n')

        let caught: unknown
        try {
            await importPlugin(tooLowVersionSource, { isUpdate: true, originalPluginName: 'Test Plugin' })
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(PluginUpdateRejection)
        expect((caught as PluginUpdateRejection).stage).toBe('parse')
        expect((caught as PluginUpdateRejection).code).toBe('version-too-low')
        expect(runtime.save).not.toHaveBeenCalled()
    })

    test('reports a durable-save failure as a save-stage PluginUpdateRejection', async () => {
        runtime.save.mockReset().mockRejectedValueOnce(new Error('disk full'))

        let caught: unknown
        try {
            await importPlugin(updatedSource, { isUpdate: true, originalPluginName: 'Test Plugin' })
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(PluginUpdateRejection)
        expect((caught as PluginUpdateRejection).stage).toBe('save')
        expect((caught as PluginUpdateRejection).code).toBe('durable-save-failed')
        expect((caught as PluginUpdateRejection).detail).toBe('disk full')
    })
})
