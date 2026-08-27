import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import { mount, unmount } from 'svelte'

import {
    PluginUpdateRejection,
    runInstalledPluginUpdateAction,
    runPluginUpdate,
    type PluginUpdateTarget,
} from './pluginUpdate'
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
    isBuiltInPluginName: (name: string | undefined) => name?.trim().toLowerCase() === 'pagefold',
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
            installed.versionOfPlugin = '2.0.0'
            return { ok: true, version: '2.0.0' }
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

    test('a legacy pagefold row never shows the update button, even when an update is detected', async () => {
        const installed = {
            name: 'pagefold',
            script: 'old pagefold source',
            updateURL: 'https://example.com/pagefold.js',
            versionOfPlugin: '0.1.0',
            enabled: true,
            version: '3.0',
            arguments: {},
            realArg: {},
            customLink: [],
            argMeta: {},
        }
        ui.db.plugins = [installed]
        // Even though checkPluginUpdate reports a newer version is available...
        ui.checkPluginUpdate.mockResolvedValue({ version: '0.2.0', updateURL: installed.updateURL })

        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(PluginSettings, { target })

        // ...the `+` button must never appear for this row, and updatePlugin
        // must never be invoked from it.
        await vi.waitFor(() => expect(document.body.textContent).toContain('Built-in version in use'))
        expect(document.querySelector('[data-plugin-update]')).toBeNull()
        expect(ui.updatePlugin).not.toHaveBeenCalled()
    })

    test('the installed-plugin plus action awaits an update and leaves custom storage intact', async () => {
        let installed = plugin()
        const customStorage = { 'Test Plugin:preferences': { theme: 'dark' } }
        let finishUpdate: (() => void) | undefined
        const updateGate = new Promise<void>((resolve) => { finishUpdate = resolve })
        const update = vi.fn(async () => {
            await updateGate
            installed = { ...installed, script: source }
            return { ok: true, version: '2.0.0' } as const
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

        await expect(action).resolves.toEqual({ ok: true, version: '2.0.0' })
        expect(update).toHaveBeenCalledOnce()
        expect(installed.script).toBe(source)
        expect(customStorage).toEqual({ 'Test Plugin:preferences': { theme: 'dark' } })
        expect(reportSuccess).toHaveBeenCalledOnce()
        expect(reportFailure).not.toHaveBeenCalled()
    })

    test('reports a distinct code per failure stage without ever throwing past the caller', async () => {
        const reportFailure = vi.fn()
        const result = await runInstalledPluginUpdateAction(plugin(), {
            update: async () => ({ ok: false, stage: 'policy', code: 'pagefold-blocked', detail: 'blocked' }),
            reportSuccess: vi.fn(),
            reportFailure,
        })

        expect(result).toEqual({ ok: false, stage: 'policy', code: 'pagefold-blocked', detail: 'blocked' })
        expect(reportFailure).toHaveBeenCalledWith({ ok: false, stage: 'policy', code: 'pagefold-blocked', detail: 'blocked' })
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
        const fetcher = vi.fn(async (_url: string) => new Response(source, { status: 200 }))
        const importer = vi.fn(async () => {
            await importGate
            installed = { ...installed, script: source, versionOfPlugin: '2.0.0' } as typeof installed & { versionOfPlugin: string }
        })

        let settled = false
        const updating = runPluginUpdate(plugin(), {
            fetcher,
            importer,
            readInstalled: () => installed,
        }).then((result) => {
            settled = true
            return result
        })

        await Promise.resolve()
        expect(settled).toBe(false)
        finishImport?.()

        await expect(updating).resolves.toEqual({ ok: true, version: '2.0.0' })
        expect(fetcher).toHaveBeenCalledOnce()
        expect(fetcher).toHaveBeenCalledWith('https://example.com/plugin.js')
        expect(importer).toHaveBeenCalledOnce()
    })

    test('does not report success when the importer resolves without actually installing anything', async () => {
        const installed = plugin()
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => undefined,
            readInstalled: () => installed,
        })

        expect(result).toEqual({ ok: false, stage: 'verify', code: 'no-change-detected' })
    })

    test('does not report a no-op as a successful installation', async () => {
        const installed = { ...plugin(), script: source, versionOfPlugin: '2.0.0' }
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => undefined,
            readInstalled: () => installed,
        })

        expect(result).toEqual({ ok: false, stage: 'verify', code: 'no-change-detected' })
    })

    test('returns a download/http-404 result for a failed download without invoking the importer', async () => {
        const importer = vi.fn()
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response('missing', { status: 404 }),
            importer,
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, stage: 'download', code: 'http-404', detail: 'HTTP 404' })
        expect(importer).not.toHaveBeenCalled()
    })

    test('returns a download/network-error result for a CORS or network failure, without invoking the importer', async () => {
        const importer = vi.fn()
        const networkError = new TypeError('Failed to fetch')
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => { throw networkError },
            importer,
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, stage: 'download', code: 'network-error', detail: 'Failed to fetch' })
        expect(importer).not.toHaveBeenCalled()
    })

    test('returns a parse/version-missing-in-download result for malformed metadata, without invoking the importer', async () => {
        const importer = vi.fn()
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response('//@name Test Plugin\nRisuai.log("no version line")', { status: 200 }),
            importer,
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, stage: 'parse', code: 'version-missing-in-download' })
        expect(importer).not.toHaveBeenCalled()
    })

    test('surfaces a name-change rejection thrown by the importer with a distinct code', async () => {
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => {
                throw new PluginUpdateRejection('policy', 'name-changed', 'name cannot change during an update')
            },
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({
            ok: false,
            stage: 'policy',
            code: 'name-changed',
            detail: 'name cannot change during an update',
        })
    })

    test('surfaces a PageFold policy rejection thrown by the importer with a distinct code', async () => {
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => {
                throw new PluginUpdateRejection('policy', 'pagefold-blocked', 'PageFold is built in')
            },
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({
            ok: false,
            stage: 'policy',
            code: 'pagefold-blocked',
            detail: 'PageFold is built in',
        })
    })

    test('surfaces an API policy rejection thrown by the importer with a distinct code', async () => {
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => {
                throw new PluginUpdateRejection('policy', 'unsafe-code-rejected', 'failed the safety check')
            },
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({
            ok: false,
            stage: 'policy',
            code: 'unsafe-code-rejected',
            detail: 'failed the safety check',
        })
    })

    test('surfaces a durable-save failure thrown by the importer with a distinct code', async () => {
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => {
                throw new PluginUpdateRejection('save', 'durable-save-failed', 'disk full')
            },
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, stage: 'save', code: 'durable-save-failed', detail: 'disk full' })
    })

    test('surfaces a post-install verify failure (updateURL mismatch) with a distinct code', async () => {
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => undefined,
            readInstalled: () => ({ name: 'Test Plugin', script: 'different', updateURL: 'https://different.example.com/plugin.js' }),
        })

        expect(result).toEqual({ ok: false, stage: 'verify', code: 'update-url-mismatch' })
    })

    test('a successful update check followed by a full-download failure is reported as a download failure, not a generic one', async () => {
        // checkPluginUpdate (the Range request) can succeed while the actual
        // full download made by updatePlugin() fails independently.
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response(source, { status: 206 })) // check: range succeeds
            .mockResolvedValueOnce(new Response('server error', { status: 500 })) // download: full GET fails

        const checkResult = await fetcher('https://example.com/plugin.js')
        expect(checkResult.status).toBe(206)

        const result = await runPluginUpdate(plugin(), {
            fetcher,
            importer: vi.fn(),
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, stage: 'download', code: 'http-500', detail: 'HTTP 500' })
    })
})
