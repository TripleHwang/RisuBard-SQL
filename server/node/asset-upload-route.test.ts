import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'

const { createAssetUploadHandler } = require('./asset-upload-route.cjs')

const servers: http.Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

function makeApp(overrides: Record<string, any> = {}) {
    const calls: string[] = []
    const app = express()
    app.post('/api/assets/upload', createAssetUploadHandler({
        checkAuth: async () => { calls.push('auth'); return true },
        checkActiveSession: () => { calls.push('session'); return true },
        stagingRoot: process.cwd(),
        getAvailableBytes: () => Number.MAX_SAFE_INTEGER,
        spoolSourceToOwnedFile: async (source: AsyncIterable<Uint8Array>) => {
            calls.push('spool'); let bytes = 0; for await (const chunk of source) bytes += chunk.length
            return { ownedDir: process.cwd(), filePath: 'asset.bin', bytes }
        },
        kvSetManyFromFilesAsync: async (entries: any[]) => { calls.push('publish'); expect(entries).toEqual([{ key: 'assets/test.png', sourcePath: 'asset.bin' }]) },
        removeOwnedDir: async () => calls.push('cleanup'),
        ...overrides,
    }))
    const server = http.createServer(app); servers.push(server)
    return { server, calls }
}
async function request(server: http.Server, body = 'pixels', headers: Record<string, string> = {}) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return await new Promise<{ status: number, body: any }>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/api/assets/upload', method: 'POST', headers: {
            'content-type': 'application/octet-stream', 'content-length': String(Buffer.byteLength(body)), 'x-risu-asset-key': 'assets/test.png', ...headers,
        } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : null })) })
        req.on('error', reject); req.end(body)
    })
}

describe('createAssetUploadHandler', () => {
    it('spools the raw body and publishes it once from the staged file', async () => {
        const { server, calls } = makeApp()
        await expect(request(server)).resolves.toMatchObject({ status: 200, body: { success: true, bytes: 6 } })
        expect(calls).toEqual(['auth', 'session', 'spool', 'publish', 'cleanup'])
    })
    it.each([
        [{ checkAuth: async (_req: any, res: any) => { res.status(401).end(); return false } }, {}, 401],
        [{}, { 'x-risu-asset-key': '../assets/nope' }, 400],
        [{}, { 'x-risu-asset-key': 'assets/../nope' }, 400],
        [{}, { 'content-type': 'text/plain' }, 415],
        [{}, { 'content-length': String(256 * 1024 * 1024 + 1) }, 413],
        [{ getAvailableBytes: () => 0 }, {}, 507],
    ])('rejects unsafe or unauthenticated requests', async (overrides, headers, status) => {
        const { server, calls } = makeApp(overrides)
        const response = await request(server, '', headers)
        expect(response.status).toBe(status)
        expect(calls).not.toContain('spool')
    })
    it('cleans the staged directory when manifest publication fails', async () => {
        const { server, calls } = makeApp({ kvSetManyFromFilesAsync: async () => { throw new Error('publish failed') } })
        const response = await request(server)
        expect(response.status).toBe(500)
        expect(calls).toContain('cleanup')
    })
})
