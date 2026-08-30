import { describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'

import {
    describePluginUpdateFailure,
    runPluginUpdate,
    type InstalledPluginSnapshot,
    type PluginUpdateTarget,
} from './pluginUpdate'

const source = [
    '//@name Test Plugin',
    '//@api 3.0',
    '//@version 2.0.0',
    '//@update-url https://example.com/plugin.js',
    'Risuai.log("updated")',
].join('\n')

const renamedSource = source.replace('//@name Test Plugin', '//@name Renamed Plugin')

function plugin(): PluginUpdateTarget & { script: string } {
    return {
        id: 'install-1',
        name: 'Test Plugin',
        script: 'old source',
        updateURL: 'https://example.com/plugin.js',
    }
}

/** A `readInstalled` over a plugin list, resolving the way the app does. */
function installedList(plugins: InstalledPluginSnapshot[]) {
    return (target: PluginUpdateTarget) =>
        target.id
            ? plugins.find((candidate) => candidate.id === target.id)
            : plugins.find((candidate) => !candidate.id && candidate.name === target.name)
}

describe('plugin updater', () => {
    test('downloads update sources through the native fetch fallback', () => {
        const importerSource = fs.readFileSync('src/ts/plugins/plugins.svelte.ts', 'utf8')
        expect(importerSource).toContain("fetcher: (url) => fetchNative(url, { method: 'GET' })")
        expect(importerSource).not.toContain('fetcher: fetch,')
    })

    test('flushes patch persistence before an update can report success', () => {
        const importerSource = fs.readFileSync('src/ts/plugins/plugins.svelte.ts', 'utf8')
        const saveSource = fs.readFileSync('src/ts/globalApi.svelte.ts', 'utf8')
        expect(importerSource).toContain('await requestImmediateSave({ flushServer: true, rejectOnFailure: true })')
        expect(importerSource).not.toContain('await requestImmediateSave({ forceFullWrite: true, rejectOnFailure: true })')
        expect(saveSource).toContain('if (options?.flushServer && supportsPatchSync)')
        expect(saveSource).toContain('await flushServerDbNow()')
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
        }).then((result) => {
            settled = true
            return result
        })

        await Promise.resolve()
        expect(settled).toBe(false)
        finishImport?.()

        await expect(updating).resolves.toEqual({ ok: true })
        expect(fetcher).toHaveBeenCalledOnce()
        expect(importer).toHaveBeenCalledOnce()
    })

    test('an update that renames the plugin still resolves its own install', async () => {
        // The defect this exists for: a plugin whose update declares a different
        // `//@name` used to be looked up by that new name after the import, so
        // the updater either found some other user's install or declared the
        // update a failure. Identity is what makes a rename an ordinary update.
        const installs: InstalledPluginSnapshot[] = [
            { id: 'install-1', name: 'Test Plugin', script: 'old source' },
            { id: 'install-2', name: 'Renamed Plugin', script: 'a different plugin entirely' },
        ]
        const importer = vi.fn(async () => {
            installs[0] = { id: 'install-1', name: 'Renamed Plugin', script: renamedSource }
        })

        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(renamedSource, { status: 200 }),
            importer,
            readInstalled: installedList(installs),
        })

        expect(result).toEqual({ ok: true })
        // The bystander that happened to hold the new name is untouched.
        expect(installs[1]).toEqual({ id: 'install-2', name: 'Renamed Plugin', script: 'a different plugin entirely' })
    })

    test('never falls back to a name match when the identity is gone', async () => {
        // Uninstalling the target mid-update must read as "gone", not as
        // "here is a same-named stranger, call it updated".
        const installs: InstalledPluginSnapshot[] = [
            { id: 'install-9', name: 'Test Plugin', script: source },
        ]
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => undefined,
            readInstalled: installedList(installs),
        })

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.failure.kind).toBe('not-installed')
    })

    test('names a download failure instead of collapsing it', async () => {
        const importer = vi.fn()
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response('missing', { status: 404 }),
            importer,
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, failure: { kind: 'download-failed', status: 404 } })
        expect(importer).not.toHaveBeenCalled()
        expect(describePluginUpdateFailure((result as any).failure)).toContain('404')
    })

    test('names a transport failure and does not import', async () => {
        const importer = vi.fn()
        const boom = new Error('network down')
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => { throw boom },
            importer,
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, failure: { kind: 'download-failed', status: 0, error: boom } })
        expect(importer).not.toHaveBeenCalled()
        expect(describePluginUpdateFailure((result as any).failure)).toContain('network down')
    })

    test('carries the installer refusal reason through', async () => {
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => ({ ok: false, reason: 'plugin version must be at least 0.0.1' }),
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({
            ok: false,
            failure: { kind: 'rejected', detail: 'plugin version must be at least 0.0.1' },
        })
        expect(describePluginUpdateFailure((result as any).failure)).toContain('at least 0.0.1')
    })

    test('reports an import that did not install the downloaded source', async () => {
        const installed = plugin()
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => undefined,
            readInstalled: () => installed,
        })

        expect(result.ok).toBe(false)
        expect(result.ok === false && result.failure.kind).toBe('not-installed')
    })

    test('distinguishes "already current" from a failed install', async () => {
        const installed = { ...plugin(), script: source }
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => undefined,
            readInstalled: () => installed,
        })

        expect(result).toEqual({ ok: false, failure: { kind: 'already-current' } })
        expect(describePluginUpdateFailure((result as any).failure)).toContain('already identical')
    })

    test('reports a plugin with no update URL as such', async () => {
        const importer = vi.fn()
        const result = await runPluginUpdate({ id: 'install-1', name: 'Test Plugin' }, {
            fetcher: async () => new Response(source, { status: 200 }),
            importer,
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, failure: { kind: 'no-update-url' } })
        expect(importer).not.toHaveBeenCalled()
    })

    test('carries a thrown error instead of flattening it', async () => {
        const boom = new Error('importer exploded')
        const result = await runPluginUpdate(plugin(), {
            fetcher: async () => new Response(source, { status: 200 }),
            importer: async () => { throw boom },
            readInstalled: () => plugin(),
        })

        expect(result).toEqual({ ok: false, failure: { kind: 'threw', error: boom } })
        expect(describePluginUpdateFailure((result as any).failure)).toContain('importer exploded')
    })

    test('every failure kind describes itself', () => {
        const kinds = [
            { kind: 'no-update-url' },
            { kind: 'download-failed', status: 500 },
            { kind: 'download-failed', status: 0, error: new Error('offline') },
            { kind: 'rejected', detail: 'bad version' },
            { kind: 'already-current' },
            { kind: 'not-installed', detail: 'gone' },
            { kind: 'threw', error: new Error('boom') },
        ] as const
        for (const failure of kinds) {
            expect(describePluginUpdateFailure(failure).length).toBeGreaterThan(0)
        }
    })
})
