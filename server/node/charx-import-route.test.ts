import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'

const { createCharXImportHandler } = require('./charx-import-route.cjs')

type HandlerDeps = Record<string, any>
const servers: http.Server[] = []

afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

function makeApp(overrides: Partial<HandlerDeps> = {}) {
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
        ...overrides,
    }
    const app = express()
    app.post('/api/charx/import', createCharXImportHandler(deps))
    const server = http.createServer(app)
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
        ['application/x-risu-charx', 413, { 'content-length': String(256 * 1024 * 1024 + 1) }, 'known oversize'],
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

    it('maps insufficient disk space to 507 before writing NDJSON headers', async () => {
        const { server, calls } = makeApp({ getAvailableBytes: () => 0 })
        const response = await request(server, 'x')
        expect(response.status).toBe(507)
        expect(calls).not.toContain('import')
        expect(calls).toContain('end')
    })

    it('streams throttled progress and done framing with no-cache headers', async () => {
        const { server } = makeApp()
        const response = await request(server, 'abc')
        expect(response.status).toBe(200)
        expect(response.headers['content-type']).toContain('application/x-ndjson')
        expect(response.headers['cache-control']).toContain('no-cache')
        expect(response.headers['x-accel-buffering']).toBe('no')
        const events = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line))
        expect(events.some(event => event.type === 'progress')).toBe(true)
        expect(events.at(-1)).toMatchObject({ type: 'done', result: { card: { spec: 'chara_card_v3' } } })
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
    })
})
