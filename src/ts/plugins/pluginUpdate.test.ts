import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import { mount, unmount } from 'svelte'

import { runInstalledPluginUpdateAction, runPluginUpdate, type PluginUpdateTarget } from './pluginUpdate'
import PluginSettings from 'src/lib/Setting/Pages/PluginSettings.svelte'

const ui = vi.hoisted(() => ({
    db: {
        plugins: [] as Array<PluginUpdateTarget & Record<string, unknown>>,
        pluginCustomStorage: {} as Record<string, unknown>,
        collectionOrganizers: { plugins: { folders: [], folderByItemId: {}, itemOrder: [] } },
    },
    checkPluginUpdate: vi.fn(),
    updatePlugin: vi.fn(),
    alertConfirm: vi.fn(),
    notifySuccess: vi.fn(),
    notifyError: vi.fn(),
}))

vi.mock('src/ts/plugins/plugins.svelte', () => ({
    checkPluginUpdate: ui.checkPluginUpdate,
    updatePlugin: ui.updatePlugin,
    createBlankPlugin: vi.fn(),
    importPlugin: vi.fn(),
    loadPlugins: vi.fn(),
}))
vi.mock('src/ts/stores.svelte', async (importOriginal) => ({
    ...await importOriginal<typeof import('src/ts/stores.svelte')>(),
    DBState: { db: ui.db },
    hotReloading: [],
}))
vi.mock('src/ts/storage/database.svelte', async (importOriginal) => ({
    ...await importOriginal<typeof import('src/ts/storage/database.svelte')>(),
    getDatabase: () => ui.db,
}))
vi.mock('src/ts/alert', () => ({
    alertConfirm: ui.alertConfirm,
    alertMd: vi.fn(),
    alertSelect: vi.fn(),
    notifySuccess: ui.notifySuccess,
    notifyError: ui.notifyError,
}))
vi.mock('src/ts/globalApi.svelte', async (importOriginal) => ({
    ...await importOriginal<typeof import('src/ts/globalApi.svelte')>(),
    requestImmediateSave: vi.fn(),
}))
vi.mock('src/ts/plugins/apiV3/v3.svelte', () => ({ resetPluginPermission: vi.fn() }))
vi.mock('src/ts/plugins/apiV3/developMode', () => ({ hotReloadPluginFiles: vi.fn() }))

const source = [
    '//@name Test Plugin',
    '//@api 3.0',
    '//@version 2.0.0',
    '//@update-url https://example.com/plugin.js',
    'Risuai.log("updated")',
].join('\n')

function plugin(): PluginUpdateTarget & { script: string } {
    return {
        name: 'Test Plugin',
        script: 'old source',
        updateURL: 'https://example.com/plugin.js',
    }
}

describe('plugin updater', () => {
    let mounted: ReturnType<typeof mount> | undefined

    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
        ui.checkPluginUpdate.mockReset()
        ui.updatePlugin.mockReset()
        ui.alertConfirm.mockReset()
        ui.notifySuccess.mockReset()
        ui.notifyError.mockReset()
    })

    test('the plugin-row plus action waits for the installed update and preserves custom storage', async () => {
        const installed = {
            ...plugin(),
            versionOfPlugin: '1.0.0',
            enabled: true,
            version: '3.0',
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
        }
        ui.db.plugins = [installed]
        ui.db.pluginCustomStorage = { 'Test Plugin:preferences': { theme: 'dark' } }
        ui.checkPluginUpdate.mockResolvedValue({ version: '2.0.0', updateURL: installed.updateURL })
        ui.alertConfirm.mockResolvedValue(true)
        let finishUpdate: (() => void) | undefined
        const updateGate = new Promise<void>((resolve) => { finishUpdate = resolve })
        ui.updatePlugin.mockImplementation(async () => {
            await updateGate
            installed.script = source
            return true
        })

        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(PluginSettings, { target })
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-plugin-update]')).not.toBeNull())

        document.querySelector<HTMLButtonElement>('[data-plugin-update]')!.click()
        await vi.waitFor(() => expect(ui.updatePlugin).toHaveBeenCalledOnce())
        expect(ui.notifySuccess).not.toHaveBeenCalled()
        finishUpdate?.()

        await vi.waitFor(() => expect(ui.notifySuccess).toHaveBeenCalledOnce())
        expect(installed.script).toBe(source)
        expect(ui.db.pluginCustomStorage).toEqual({ 'Test Plugin:preferences': { theme: 'dark' } })
        expect(ui.notifyError).not.toHaveBeenCalled()
    })

    test('the installed-plugin plus action awaits an update and leaves custom storage intact', async () => {
        let installed = plugin()
        const customStorage = { 'Test Plugin:preferences': { theme: 'dark' } }
        let finishUpdate: (() => void) | undefined
        const updateGate = new Promise<void>((resolve) => { finishUpdate = resolve })
        const update = vi.fn(async () => {
            await updateGate
            installed = { ...installed, script: source }
            return true
        })
        const reportSuccess = vi.fn()
        const reportFailure = vi.fn()

        let settled = false
        const action = runInstalledPluginUpdateAction(plugin(), {
            update,
            reportSuccess,
            reportFailure,
        }).then((result) => {
            settled = true
            return result
        })

        await Promise.resolve()
        expect(settled).toBe(false)
        finishUpdate?.()

        await expect(action).resolves.toBe(true)
        expect(update).toHaveBeenCalledOnce()
        expect(installed.script).toBe(source)
        expect(customStorage).toEqual({ 'Test Plugin:preferences': { theme: 'dark' } })
        expect(reportSuccess).toHaveBeenCalledOnce()
        expect(reportFailure).not.toHaveBeenCalled()
    })

    test('waits for a durable database save before an update can report success', () => {
        const importerSource = fs.readFileSync('src/ts/plugins/plugins.svelte.ts', 'utf8')
        expect(importerSource).toContain('await requestImmediateSave({ rejectOnFailure: true })')
        expect(importerSource).toMatch(/catch \(error\) \{[\s\S]*?if \(argu\.isUpdate\) throw error/)
    })

    test('bypasses browser cache, awaits import, and verifies installed source', async () => {
        let installed = plugin()
        let finishImport: (() => void) | undefined
        const importGate = new Promise<void>((resolve) => { finishImport = resolve })
        const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
            expect(init?.cache).toBe('no-store')
            return new Response(source, { status: 200 })
        })
        const importer = vi.fn(async () => {
            await importGate
            installed = { ...installed, script: source }
        })

        let settled = false
        const updating = runPluginUpdate(plugin(), {
            fetcher,
            importer,
            readInstalled: () => installed,
        }).then((result: boolean) => {
            settled = true
            return result
        })

        await Promise.resolve()
        expect(settled).toBe(false)
        finishImport?.()

        await expect(updating).resolves.toBe(true)
        expect(fetcher).toHaveBeenCalledOnce()
        expect(importer).toHaveBeenCalledOnce()
    })

    test('returns false when the importer does not install the downloaded source', async () => {
        const installed = plugin()
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => undefined,
            readInstalled: () => installed,
        })

        expect(result).toBe(false)
    })

    test('does not report a no-op as a successful installation', async () => {
        const installed = { ...plugin(), script: source }
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => undefined,
            readInstalled: () => installed,
        })

        expect(result).toBe(false)
    })

    test('returns false for a failed download without invoking the importer', async () => {
        const importer = vi.fn()
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response('missing', { status: 404 }),
            importer,
            readInstalled: () => plugin(),
        })

        expect(result).toBe(false)
        expect(importer).not.toHaveBeenCalled()
    })
})
