import { describe, expect, test, vi } from 'vitest'

import { runPluginUpdate, type PluginUpdateTarget } from './pluginUpdate'

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
