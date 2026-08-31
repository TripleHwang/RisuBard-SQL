import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import http from 'node:http'

const { createCharXImportHandler } = require('./charx-import-route.cjs')
const { DEFAULT_CHARX_LIMITS } = require('./charx-import.cjs')

type HandlerDeps = Record<string, any>
const servers: http.Server[] = []

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

function makeApp(overrides: Partial<HandlerDeps> = {}) {
    const { serverOptions = {}, ...dependencyOverrides } = overrides
    const calls: string[] = []
    const deps: HandlerDeps = {
        checkAuth: async () => { calls.push('auth'); return true },
        checkActiveSession: () => { calls.push('session'); return true },
        beginImport: () => { calls.push('begin'); return true },
        endImport: () => calls.push('end'),
        stagingRoot: process.cwd(),
        getAvailableBytes: () => Number.MAX_SAFE_INTEGER,
        heartbeatMs: 5,
        logger: { warn: () => {} },
        publishAssets: async () => { calls.push('publish') },
        importCharXStream: async (source: AsyncIterable<Uint8Array>, options: any) => {
            calls.push('import')
            const chunks: Uint8Array[] = []
            for await (const chunk of source) chunks.push(chunk)
            options.onProgress({ compressedBytes: chunks.reduce((sum, chunk) => sum + chunk.length, 0), decompressedBytes: 7 })
            return { card: { spec: 'chara_card_v3' }, moduleBase64: null, assets: {}, excludedFiles: [], warnings: [] }
        },
        ...dependencyOverrides,
    }
    const app = express()
    app.post('/api/charx/import', rateLimit({
        windowMs: 60 * 1000,
        max: 1000,
        standardHeaders: true,
        legacyHeaders: false,
        validate: { xForwardedForHeader: false },
    }), createCharXImportHandler(deps))
    const server = http.createServer(serverOptions, app)
    servers.push(server)
    return { server, calls, deps }
}

async function request(server: http.Server, body: string, headers: Record<string, string> = {}) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as { port: number }
    return await new Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/charx/import', method: 'POST', headers: { 'content-type': 'application/x-risu-charx', 'content-length': Buffer.byteLength(body), accept: 'application/x-ndjson', ...headers } }, res => {
            let response = ''
            res.setEncoding('utf8')
            res.on('data', chunk => response += chunk)
            res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: response }))
        })
        req.on('error', reject)
        req.end(body)
    })
}

describe('createCharXImportHandler', () => {
    it('authenticates and checks the active session before consuming a streamed body', async () => {
        let imported = false
        const { server, calls } = makeApp({
            importCharXStream: async (source: AsyncIterable<Uint8Array>) => {
                calls.push('import')
                expect(calls).toEqual(['auth', 'session', 'begin', 'import'])
                imported = true
                for await (const _chunk of source) {}
                return { card: { spec: 'chara_card_v3' }, moduleBase64: null, assets: {}, excludedFiles: [], warnings: [] }
            },
        })
        const response = await request(server, 'raw-streamed-body')
        expect(response.status).toBe(200)
        expect(imported).toBe(true)
        expect(calls).toContain('end')
        expect(response.body.split('\n').filter(Boolean).map(line => JSON.parse(line).type)).toContain('done')
    })

    it.each([
        ['text/plain', 415, {}, 'wrong content type'],
        ['application/x-risu-charx-not-really', 415, {}, 'lookalike content type'],
        // Derived from the limit rather than restated, so raising the cap
        // cannot leave this asserting a 413 the route no longer answers --
        // which does not fail loudly here, it hangs waiting for a body.
        ['application/x-risu-charx', 413, { 'content-length': String(DEFAULT_CHARX_LIMITS.compressedBytes + 1) }, 'known oversize'],
    ])('returns %i for %s before importing', async (contentType, status, headers) => {
        const { server, calls } = makeApp()
        const response = await request(server, '', { 'content-type': contentType, ...headers })
        expect(response.status).toBe(status)
        expect(calls).not.toContain('import')
    })

    it('returns 409 for the shared import lock and releases the lock after a helper error without leaking paths', async () => {
        const busy = makeApp({ beginImport: () => false })
        const busyResponse = await request(busy.server, 'x')
        expect(busyResponse.status).toBe(409)

        const failed = makeApp({ importCharXStream: async () => { const error: any = new Error('bad /tmp/charx-secret'); error.code = 'INVALID_CHARX'; error.status = 400; throw error } })
        const failedResponse = await request(failed.server, 'x')
        expect(failedResponse.status).toBe(200)
        expect(failed.calls).toContain('end')
        expect(failedResponse.body).toContain('"type":"error"')
        expect(failedResponse.body).not.toContain('/tmp/')
        expect(failedResponse.body).not.toContain('Error:')
    })

    it.each([
        ['INVALID_CHARX', 400],
        ['CHARX_LIMIT_EXCEEDED', 413],
        ['INSUFFICIENT_STORAGE', 507],
        ['ASSET_COMMIT_FAILED', 500],
    ])('includes mapped status %i in post-header NDJSON errors for %s', async (code, status) => {
        const { server } = makeApp({
            importCharXStream: async () => {
                const error: any = new Error('internal staging path must not escape')
                error.code = code
                error.status = status
                throw error
            },
        })
        const response = await request(server, 'x')
        expect(response.status).toBe(200)
        const event = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(line => line.type === 'error')
        expect(event).toMatchObject({ type: 'error', code, status })
    })

    it('maps insufficient disk space to 507 before writing NDJSON headers', async () => {
        const { server, calls } = makeApp({ getAvailableBytes: () => 0 })
        const response = await request(server, 'x')
        expect(response.status).toBe(507)
        expect(calls).not.toContain('import')
        expect(calls).toContain('end')
    })

    it('streams the locked flat progress contract and done framing with no-cache headers', async () => {
        const { server } = makeApp()
        const response = await request(server, 'abc')
        expect(response.status).toBe(200)
        expect(response.headers['content-type']).toContain('application/x-ndjson')
        expect(response.headers['cache-control']).toContain('no-cache')
        expect(response.headers['x-accel-buffering']).toBe('no')
        const events = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line))
        const progress = events.find(event => event.type === 'progress')
        // Wire contract consumed by NodeStorage.importCharX: never re-nest this.
        expect(progress).toEqual({ type: 'progress', completed: 3, total: 3 })
        expect(progress.progress).toBeUndefined()
        expect(events.at(-1)).toMatchObject({ type: 'done', result: { card: { spec: 'chara_card_v3' } } })
    })

    it('uses a nondecreasing safe total for progress when Content-Length is unknown', async () => {
        const { server } = makeApp({
            importCharXStream: async (_source: AsyncIterable<Uint8Array>, options: any) => {
                options.onProgress({ compressedBytes: 3, decompressedBytes: 7 })
                options.onProgress({ compressedBytes: 5, decompressedBytes: 9 })
                return { card: { spec: 'chara_card_v3' }, moduleBase64: null, assets: {}, excludedFiles: [], warnings: [] }
            },
        })
        const response = await request(server, '', { 'content-length': '0' })
        const progress = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === 'progress')
        expect(progress).toEqual([
            { type: 'progress', completed: 3, total: 3 },
        ])
    })

    it('emits the final extraction progress event even inside the throttle window', async () => {
        const { server } = makeApp({
            importCharXStream: async (_source: AsyncIterable<Uint8Array>, options: any) => {
                options.onProgress({ phase: 'extracting', completed: 0, total: 2 })
                options.onProgress({ phase: 'extracting', completed: 1, total: 2 })
                options.onProgress({ phase: 'extracting', completed: 2, total: 2, terminal: true })
                return { card: { spec: 'chara_card_v3' }, moduleBase64: null, assets: {}, excludedFiles: [], warnings: [] }
            },
        })
        const response = await request(server, 'x')
        const progress = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === 'progress')
        expect(progress).toEqual([
            { type: 'progress', completed: 0, total: 2 },
            { type: 'progress', completed: 2, total: 2 },
        ])
    })

    it('bounds many zero-byte extraction entries and emits only the explicit terminal progress', async () => {
        const { server } = makeApp({
            importCharXStream: async (_source: AsyncIterable<Uint8Array>, options: any) => {
                options.onProgress({ phase: 'extracting', completed: 0, total: 1 })
                for (let index = 0; index < 1000; index++) options.onProgress({ phase: 'extracting', completed: 1, total: 1 })
                options.onProgress({ phase: 'extracting', completed: 1, total: 1, terminal: true })
                return { card: { spec: 'chara_card_v3' }, moduleBase64: null, assets: {}, excludedFiles: [], warnings: [] }
            },
        })
        const response = await request(server, 'x')
        const progress = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === 'progress')
        expect(progress).toHaveLength(2)
        expect(progress.at(-1)).toEqual({ type: 'progress', completed: 1, total: 1 })
    })

    it('temporarily disables the server body timeout and restores it after a successful import', async () => {
        let requestTimeoutDuringImport: number | undefined
        const { server } = makeApp({
            importCharXStream: async (source: AsyncIterable<Uint8Array>) => {
                requestTimeoutDuringImport = (source as any).socket.server.requestTimeout
                for await (const _chunk of source) {}
                return { card: { spec: 'chara_card_v3' }, moduleBase64: null, assets: {}, excludedFiles: [], warnings: [] }
            },
        })
        server.requestTimeout = 123
        await request(server, 'x')
        expect(requestTimeoutDuringImport).toBe(0)
        expect(server.requestTimeout).toBe(123)
    })

    it('accepts an active upload that outlasts the server body timeout', async () => {
        const { server } = makeApp({ serverOptions: { requestTimeout: 30, connectionsCheckingInterval: 10 } })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address() as { port: number }
        const response = await new Promise<{ status: number, body: string }>((resolve, reject) => {
            const client = http.request({
                hostname: '127.0.0.1', port: address.port, path: '/api/charx/import', method: 'POST',
                headers: { 'content-type': 'application/x-risu-charx', 'content-length': '1', accept: 'application/x-ndjson' },
            }, res => {
                let body = ''
                res.setEncoding('utf8')
                res.on('data', chunk => body += chunk)
                res.on('end', () => resolve({ status: res.statusCode || 0, body }))
            })
            client.on('error', reject)
            client.flushHeaders()
            setTimeout(() => client.end('x'), 75)
        })
        expect(response.status).toBe(200)
        expect(response.body).toContain('"type":"done"')
        expect(server.requestTimeout).toBe(30)
    })

    it('restores the server body timeout after an import error', async () => {
        const { server } = makeApp({
            importCharXStream: async () => {
                const error: any = new Error('invalid archive')
                error.code = 'INVALID_CHARX'
                error.status = 400
                throw error
            },
        })
        server.requestTimeout = 123
        await request(server, 'x')
        expect(server.requestTimeout).toBe(123)
    })

    it('does not overwrite a concurrent server body-timeout change during cleanup', async () => {
        const { server } = makeApp({
            importCharXStream: async (source: AsyncIterable<Uint8Array>) => {
                expect((source as any).socket.server.requestTimeout).toBe(0)
                ;(source as any).socket.server.requestTimeout = 456
                for await (const _chunk of source) {}
                return { card: { spec: 'chara_card_v3' }, moduleBase64: null, assets: {}, excludedFiles: [], warnings: [] }
            },
        })
        server.requestTimeout = 123
        await request(server, 'x')
        expect(server.requestTimeout).toBe(456)
    })

    it('does not abort a normally completed response when Express closes it', async () => {
        let signal: AbortSignal | undefined
        const { server } = makeApp({
            importCharXStream: async (source: AsyncIterable<Uint8Array>, options: any) => {
                signal = options.signal
                for await (const _chunk of source) {}
                return { card: { spec: 'chara_card_v3' }, moduleBase64: null, assets: {}, excludedFiles: [], warnings: [] }
            },
        })
        await request(server, 'complete')
        expect(signal?.aborted).toBe(false)
    })

    it('aborts extraction after a complete upload when the response connection closes', async () => {
        let started!: () => void
        const importStarted = new Promise<void>(resolve => { started = resolve })
        let aborted = false
        const { server, calls } = makeApp({
            importCharXStream: async (source: AsyncIterable<Uint8Array>, options: any) => {
                for await (const _chunk of source) {}
                await new Promise<void>(resolve => {
                started()
                options.signal.addEventListener('abort', () => {
                    aborted = true
                    resolve()
                }, { once: true })
                setTimeout(resolve, 50)
                })
                if (!aborted) {
                    const error: any = new Error('response disconnect was ignored')
                    error.code = 'IMPORT_ABORTED'
                    error.status = 499
                    throw error
                }
            },
        })
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address() as { port: number }
        let responseReady!: () => void
        const responseStarted = new Promise<void>(resolve => { responseReady = resolve })
        let incomingResponse: http.IncomingMessage | undefined
        const client = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/charx/import', method: 'POST', headers: { 'content-type': 'application/x-risu-charx', 'content-length': '8', accept: 'application/x-ndjson' } }, response => {
            response.on('error', () => {})
            incomingResponse = response
            responseReady()
        })
        client.on('error', () => {})
        client.end('complete')
        await importStarted
        await responseStarted
        incomingResponse!.destroy()
        await new Promise(resolve => setTimeout(resolve, 75))
        expect(aborted).toBe(true)
        expect(calls).toContain('end')
    })

    it('aborts a disconnected stream and releases the shared import lock', async () => {
        let aborted = false
        let started!: () => void
        const importStarted = new Promise<void>(resolve => { started = resolve })
        let abortObserved!: () => void
        const abortEvent = new Promise<void>(resolve => { abortObserved = resolve })
        const { server, calls } = makeApp({
            importCharXStream: async (_source: AsyncIterable<Uint8Array>, options: any) => await new Promise((_, reject) => {
                started()
                options.signal.addEventListener('abort', () => {
                    aborted = true
                    abortObserved()
                    const error: any = new Error('aborted')
                    error.code = 'IMPORT_ABORTED'
                    error.status = 499
                    reject(error)
                }, { once: true })
            }),
        })
        server.requestTimeout = 123
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
        const address = server.address() as { port: number }
        const client = http.request({ hostname: '127.0.0.1', port: address.port, path: '/api/charx/import', method: 'POST', headers: { 'content-type': 'application/x-risu-charx', 'content-length': '10', accept: 'application/x-ndjson' } })
        client.on('error', () => {})
        client.write('partial')
        await importStarted
        client.destroy()
        await abortEvent
        await new Promise(resolve => setImmediate(resolve))
        expect(aborted).toBe(true)
        expect(calls).toContain('end')
        expect(server.requestTimeout).toBe(123)
    })
})
