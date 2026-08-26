import { afterEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'

const { createRisumImportHandler } = require('./risum-import-route.cjs')

const servers: http.Server[] = []
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

function makeApp(overrides: Record<string, any> = {}) {
    const calls: string[] = []
    const deps = {
        checkAuth: async () => { calls.push('auth'); return true },
        checkActiveSession: () => { calls.push('session'); return true },
        beginImport: () => { calls.push('begin'); return true },
        endImport: () => calls.push('end'),
        stagingRoot: process.cwd(),
        getAvailableBytes: () => Number.MAX_SAFE_INTEGER,
        heartbeatMs: 5,
        logger: { warn: () => {} },
        spoolSourceToOwnedFile: async (source: AsyncIterable<Uint8Array>, options: any) => {
            calls.push('spool')
            for await (const _ of source) {}
            options.onProgress?.({ bytes: 3 })
            return { ownedDir: process.cwd(), filePath: 'archive.risum', bytes: 3 }
        },
        removeOwnedDir: async () => { calls.push('cleanup') },
        importRisumFile: async (_options: any) => {
            calls.push('import')
            _options.onProgress({ phase: 'validate', completed: 1, total: 1 })
            return { module: { type: 'risuModule' }, assets: 0, decodedBytes: 3 }
        },
        publishAssets: async () => calls.push('publish'),
        ...overrides,
    }
    const app = express()
    app.post('/api/risum/import', createRisumImportHandler(deps))
    const server = http.createServer(app)
    servers.push(server)
    return { server, calls }
}

async function request(server: http.Server, body = 'abc', headers: Record<string, string> = {}) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return await new Promise<{ status: number, body: string }>((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: '/api/risum/import', method: 'POST', headers: {
            'content-type': 'application/x-risu-module', 'content-length': String(Buffer.byteLength(body)), accept: 'application/x-ndjson', ...headers,
        } }, res => {
            let response = ''; res.setEncoding('utf8'); res.on('data', chunk => response += chunk); res.on('end', () => resolve({ status: res.statusCode || 0, body: response }))
        })
        req.on('error', reject); req.end(body)
    })
}

describe('createRisumImportHandler', () => {
    it('authenticates and checks the active session before consuming the stream', async () => {
        const { server, calls } = makeApp({
            checkAuth: async (_req: any, res: any) => { calls.push('auth'); res.status(401).end(); return false },
            spoolSourceToOwnedFile: async () => { throw new Error('body was consumed') },
        })
        const response = await request(server)
        expect(response.status).toBe(401)
        expect(calls).toEqual(['auth'])
    })
    it('streams authenticated risum upload progress and done while holding one import lock', async () => {
        const { server, calls } = makeApp()
        const response = await request(server)
        const events = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line))
        expect(response.status).toBe(200)
        expect(events).toContainEqual(expect.objectContaining({ type: 'done', result: expect.objectContaining({ module: expect.any(Object) }) }))
        expect(events).toContainEqual(expect.objectContaining({ type: 'progress' }))
        expect(calls.filter(call => call === 'begin')).toHaveLength(1)
        expect(calls.filter(call => call === 'end')).toHaveLength(1)
        expect(calls).toEqual(expect.arrayContaining(['spool', 'import', 'cleanup']))
    })

    it.each([
        [{ beginImport: () => false }, {}, 409],
        [{}, { 'content-type': 'text/plain' }, 415],
        [{}, { 'content-length': String(4 * 1024 ** 3 + 1) }, 413],
        [{ getAvailableBytes: () => 0 }, {}, 507],
    ])('rejects preflight failures before consuming the archive', async (overrides, headers, status) => {
        const { server, calls } = makeApp(overrides)
        const response = await request(server, '', headers)
        expect(response.status).toBe(status)
        expect(calls).not.toContain('spool')
    })

    it('frames parser failures as safe NDJSON errors after headers', async () => {
        const { server } = makeApp({ importRisumFile: async () => { const error: any = new Error('secret path'); error.code = 'INVALID_RISUM'; error.status = 400; throw error } })
        const response = await request(server)
        expect(response.status).toBe(200)
        expect(response.body).toContain('"type":"error"')
        expect(response.body).not.toContain('secret path')
    })

    it.each([
        ['INVALID_RISUM', 400], ['IMPORT_LIMIT_EXCEEDED', 413], ['INSUFFICIENT_STORAGE', 507], ['IMPORT_ABORTED', 499],
    ])('maps %s parser errors to NDJSON status %i', async (code, status) => {
        const { server } = makeApp({ importRisumFile: async () => { const error: any = new Error('failure'); error.code = code; error.status = status; throw error } })
        const response = await request(server)
        const event = response.body.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event => event.type === 'error')
        expect(event).toMatchObject({ type: 'error', code, status })
    })

    it('restores request timeout after streaming an archive', async () => {
        let timeoutDuringImport: number | undefined
        const { server } = makeApp({ spoolSourceToOwnedFile: async (source: any) => {
            timeoutDuringImport = source.socket?.server?.requestTimeout
            for await (const _ of source) {}
            return { ownedDir: process.cwd(), filePath: 'x', bytes: 1 }
        } })
        server.requestTimeout = 123
        await request(server, 'x')
        expect(timeoutDuringImport).toBe(0)
        expect(server.requestTimeout).toBe(123)
    })
})
