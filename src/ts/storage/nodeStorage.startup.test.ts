import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))

import { NodeStorage } from './nodeStorage'

describe('NodeStorage SQL bootstrap authentication', () => {
    const originalFetch = globalThis.fetch

    afterEach(() => {
        globalThis.fetch = originalFetch
    })

    it('does not wait for the image-cookie session before an authenticated SQL request', async () => {
        const paths: string[] = []
        let finishSession!: () => void
        const sessionPending = new Promise<void>((resolve) => { finishSession = resolve })
        globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const path = String(input)
            paths.push(path)
            if (path === '/api/test_auth') return Response.json({ status: 'correct', token: 'bootstrap-jwt' })
            if (path === '/api/sql/bootstrap') return Response.json({ status: 'ready' })
            if (path === '/api/session') {
                await sessionPending
                return new Response(null, { status: 204 })
            }
            throw new Error(`unexpected request ${path}`)
        }) as typeof fetch

        const storage = new NodeStorage()
        const bootstrap = storage.authenticatedFetch('/api/sql/bootstrap')
        await expect(bootstrap).resolves.toMatchObject({ ok: true })

        expect(paths).toEqual(['/api/test_auth', '/api/sql/bootstrap', '/api/session'])

        finishSession()
        await storage.ensureSession()
    })
})
