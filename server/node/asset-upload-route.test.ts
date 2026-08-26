import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import http from 'node:http'

const { createAssetUploadHandler, suspendRequestTimeout } = require('./asset-upload-route.cjs')

const servers: http.Server[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))) })

function makeApp(overrides: Record<string, any> = {}) {
    const calls: string[] = []
    const app = express()
    app.post('/api/assets/upload', rateLimit({
        windowMs: 60 * 1000,
        max: 1000,
        standardHeaders: true,
        legacyHeaders: false,
        validate: { xForwardedForHeader: false },
    }), createAssetUploadHandler({
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
    if (!server.listening) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return await new Promise<{ status: number, body: any, headers: http.IncomingHttpHeaders }>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/api/assets/upload', method: 'POST', headers: {
            'content-type': 'application/octet-stream', 'content-length': String(Buffer.byteLength(body)), 'x-risu-asset-key': 'assets/test.png', ...headers,
        } }, res => { let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode || 0, body: text ? JSON.parse(text) : null, headers: res.headers })) })
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

    it('caps concurrent uploads and releases a slot after completion', async () => {
        const releases: Array<() => void> = []
        const started: Array<() => void> = []
        const { server } = makeApp({
            spoolSourceToOwnedFile: async () => {
                started.shift()?.()
                await new Promise<void>(resolve => releases.push(resolve))
                return { ownedDir: process.cwd(), filePath: 'asset.bin', bytes: 6 }
            },
        })
        const firstStarted = new Promise<void>(resolve => started.push(resolve))
        const secondStarted = new Promise<void>(resolve => started.push(resolve))
        const first = request(server)
        await firstStarted
        const second = request(server)
        await secondStarted

        const rejected = await request(server)
        expect(rejected).toMatchObject({ status: 429, body: { code: 'TOO_MANY_UPLOADS' } })
        expect(rejected.headers['retry-after']).toBe('1')
        releases.shift()?.()
        await expect(first).resolves.toMatchObject({ status: 200 })

        const thirdStarted = new Promise<void>(resolve => started.push(resolve))
        const third = request(server)
        await thirdStarted
        releases.shift()?.()
        releases.shift()?.()
        await expect(Promise.all([second, third])).resolves.toEqual([
            expect.objectContaining({ status: 200 }),
            expect.objectContaining({ status: 200 }),
        ])
    })

    it.each([
        ['success', {}],
        ['error', { kvSetManyFromFilesAsync: async () => { throw new Error('publish failed') } }],
    ])('suspends slow-upload timeouts and restores them after %s', async (_name, overrides) => {
        let socket: any
        const timeoutRestores: number[] = []
        let requestTimeoutDuringUpload: number | undefined
        let socketTimeoutDuringUpload: number | undefined
        const { server } = makeApp({
            ...overrides,
            spoolSourceToOwnedFile: async (source: any) => {
                socket = source.socket
                requestTimeoutDuringUpload = socket.server.requestTimeout
                socketTimeoutDuringUpload = socket.timeout
                const setTimeout = socket.setTimeout.bind(socket)
                socket.setTimeout = (value: number, ...args: any[]) => { timeoutRestores.push(value); return setTimeout(value, ...args) }
                for await (const _ of source) {}
                return { ownedDir: process.cwd(), filePath: 'asset.bin', bytes: 6 }
            },
        })
        server.requestTimeout = 123
        server.setTimeout(456)
        await request(server)
        expect(requestTimeoutDuringUpload).toBe(0)
        expect(socketTimeoutDuringUpload).toBe(0)
        expect(server.requestTimeout).toBe(123)
        expect(timeoutRestores).toContain(456)
    })

    it('restores upload timeouts after a client abort', async () => {
        let handlerSettled!: () => void
        const settled = new Promise<void>(resolve => { handlerSettled = resolve })
        let socket: any
        const timeoutRestores: number[] = []
        const { server } = makeApp({
            spoolSourceToOwnedFile: async (source: any, options: any) => {
                socket = source.socket
                const setTimeout = socket.setTimeout.bind(socket)
                socket.setTimeout = (value: number, ...args: any[]) => { timeoutRestores.push(value); return setTimeout(value, ...args) }
                return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
                    const error: any = new Error('aborted'); error.code = 'IMPORT_ABORTED'; error.status = 499
                    handlerSettled(); reject(error)
                }, { once: true }))
            },
        })
        server.requestTimeout = 123
        server.setTimeout(456)
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const { port } = server.address() as { port: number }
        const client = http.request({ hostname: '127.0.0.1', port, path: '/api/assets/upload', method: 'POST', headers: {
            'content-type': 'application/octet-stream', 'content-length': '100', 'x-risu-asset-key': 'assets/test.png',
        } })
        client.on('error', () => {})
        client.write('partial')
        await new Promise(resolve => setTimeout(resolve, 10))
        client.destroy()
        await settled
        await new Promise(resolve => setImmediate(resolve))
        expect(server.requestTimeout).toBe(123)
        expect(timeoutRestores).toContain(456)
    })
})

describe('suspendRequestTimeout', () => {
    it('reference-counts overlapping uploads and preserves concurrent configuration changes', () => {
        const server = { requestTimeout: 123 }
        const req = { socket: { server } }
        const releaseA = suspendRequestTimeout(req)
        const releaseB = suspendRequestTimeout(req)
        expect(server.requestTimeout).toBe(0)
        releaseA()
        expect(server.requestTimeout).toBe(0)
        releaseB()
        expect(server.requestTimeout).toBe(123)

        const releaseC = suspendRequestTimeout(req)
        server.requestTimeout = 789
        releaseC()
        expect(server.requestTimeout).toBe(789)
    })
})
