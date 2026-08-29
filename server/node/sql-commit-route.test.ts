import express from 'express'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { createRelationalSqlite } = require('./relational-sqlite.cjs')
const { createSqlCommitHandler } = require('./sql-commit-route.cjs')
const { createExpressErrorResponder } = require('./express-error-response.cjs')

/**
 * POST /api/sql/commit over a real socket, against a real temp database, with
 * the same terminal error handler server.cjs mounts.
 *
 * The route and the handler are tested together because the bug they fix lived
 * in the seam between them: `commit()` refused an over-cap migration with a
 * precise message, the route passed it on, and the terminal handler turned it
 * into an unlogged 500 with the message dropped. The client could only report
 * `SQL commit failed (500)`, so a migration that could never succeed looked
 * exactly like a transient server fault -- for months.
 */

const roots: string[] = []
const servers: http.Server[] = []
const storages: any[] = []
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    for (const storage of storages.splice(0)) { try { storage.close() } catch { /* closed by the test */ } }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeApp(overrides: Record<string, any> = {}, jsonLimit = '256mb') {
    const root = mkdtempSync(join(tmpdir(), 'risu-sql-commit-route-'))
    roots.push(root)
    const relationalSql = createRelationalSqlite({ dataRoot: root })
    storages.push(relationalSql)
    const logError = vi.fn()
    const app = express()
    app.use(express.json({ limit: jsonLimit }))
    app.post('/api/sql/commit', createSqlCommitHandler({
        auth: async () => true,
        activeSession: () => true,
        relationalSql,
        queue: (operation: () => Promise<unknown>) => operation(),
        ...overrides,
    }))
    app.use(createExpressErrorResponder({ logError }))
    const server = http.createServer(app)
    servers.push(server)
    return { server, relationalSql, logError }
}

async function post(server: http.Server, payload: unknown) {
    if (!server.listening) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    const body = JSON.stringify(payload)
    return await new Promise<{ status: number, body: any }>((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1', port, path: '/api/sql/commit', method: 'POST',
            headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
        }, response => {
            let text = ''
            response.on('data', chunk => { text += chunk })
            response.on('end', () => resolve({
                status: response.statusCode || 0,
                body: text ? JSON.parse(text) : null,
            }))
        })
        request.on('error', reject)
        request.end(body)
    })
}

function rows(from: number, count: number) {
    return Array.from({ length: count }, (_, index) => ({
        sql: 'INSERT INTO plugin_custom_storage (key, value) VALUES (?, ?)',
        bind: [`k${from + index}`, `{"i":${from + index}}`],
    }))
}

describe('POST /api/sql/commit', () => {
    it('carries a migration across several requests and only then reports it initialized', async () => {
        const { server, relationalSql } = makeApp()
        const first = await post(server, {
            baseRevision: 0, action: 'legacy-migration', statements: rows(0, 20),
            migration: { id: 'm1', chunk: 0, final: false, totalChunks: 3 },
        })
        expect(first.status).toBe(200)
        expect(first.body).toMatchObject({
            revision: 1,
            initialized: false,
            migration: { id: 'm1', nextChunk: 1, statementsApplied: 20, totalChunks: 3 },
        })

        const second = await post(server, {
            baseRevision: first.body.revision, action: 'legacy-migration', statements: rows(20, 20),
            migration: { id: 'm1', chunk: 1, final: false, totalChunks: 3 },
        })
        expect(second.body).toMatchObject({ initialized: false, migration: { nextChunk: 2, statementsApplied: 40 } })
        expect(relationalSql.bootstrap().status).toBe('empty')

        const third = await post(server, {
            baseRevision: second.body.revision, action: 'legacy-migration', statements: rows(40, 20),
            migration: { id: 'm1', chunk: 2, final: true, totalChunks: 3 },
        })
        expect(third.status).toBe(200)
        expect(third.body).toMatchObject({ revision: 3, initialized: true, migration: null })
        expect(relationalSql.bootstrap()).toMatchObject({ status: 'ready', migration: null })
    })

    it('answers 409 with the chunk it expects, so a client can resume instead of restarting', async () => {
        const { server } = makeApp()
        await post(server, {
            baseRevision: 0, action: 'legacy-migration', statements: rows(0, 5),
            migration: { id: 'm2', chunk: 0, final: false },
        })
        const outOfOrder = await post(server, {
            baseRevision: 1, action: 'legacy-migration', statements: rows(50, 5),
            migration: { id: 'm2', chunk: 4, final: false },
        })
        expect(outOfOrder.status).toBe(409)
        expect(outOfOrder.body).toMatchObject({
            code: 'SQL_MIGRATION_SEQUENCE',
            error: 'SQL migration chunk is out of order',
            expectedChunk: 1,
            currentRevision: 1,
            migration: { id: 'm2', nextChunk: 1 },
        })
    })

    it('keeps answering 409 with currentRevision for a plain revision conflict', async () => {
        const { server } = makeApp()
        const stale = await post(server, { baseRevision: 7, action: 'sync', statements: rows(0, 1) })
        expect(stale.status).toBe(409)
        expect(stale.body).toMatchObject({
            error: 'SQL revision conflict',
            code: 'SQL_REVISION_CONFLICT',
            currentRevision: 0,
        })
    })

    it('answers 409 rather than stamping a half-applied migration as finished', async () => {
        const { server, relationalSql } = makeApp()
        await post(server, {
            baseRevision: 0, action: 'legacy-migration', statements: rows(0, 5),
            migration: { id: 'm3', chunk: 0, final: false },
        })
        const ordinary = await post(server, { baseRevision: 1, action: 'sync', statements: rows(90, 1) })
        expect(ordinary.status).toBe(409)
        expect(ordinary.body).toMatchObject({
            code: 'SQL_MIGRATION_IN_PROGRESS',
            migration: { id: 'm3', nextChunk: 1 },
        })
        expect(relationalSql.bootstrap().status).toBe('empty')
    })

    it('answers 413 with the reason, and records it, when a commit exceeds the per-request cap', async () => {
        const { server, relationalSql, logError } = makeApp()
        // Pinned to the cap the storage really enforces by
        // sql-migration-chunks.test.ts, so this cannot drift away from it.
        const oversized = new Array(relationalSql.maxStatementsPerCommit + 1)
            .fill({ sql: 'DELETE FROM messages', bind: [] })
        const response = await post(server, { baseRevision: 0, action: 'sync', statements: oversized })
        // Previously: 500, no body detail worth reading, and nothing logged
        // anywhere. All three of those are what let this go unnoticed.
        expect(response.status).toBe(413)
        expect(response.body).toEqual({ error: 'SQL commit is too large' })
        expect(logError).toHaveBeenCalledTimes(1)
        expect(String(logError.mock.calls[0][0])).toContain('SQL commit is too large')
        expect(String(logError.mock.calls[0][0])).toContain('413')
    }, 60_000)

    it('answers 413, not 500, when the body itself is larger than the parser accepts', async () => {
        // server.cjs parses JSON at `limit: '100mb'`, and a full-cap chunk of
        // real message rows is ~90 MB -- so the byte limit, not just the
        // statement cap, is a boundary a chunking client has to respect. The
        // error express raises here is a PayloadTooLargeError, which the old
        // terminal handler flattened into an unlogged 500 that no client could
        // act on and no operator could see.
        const { server, logError } = makeApp({}, '2kb')
        const response = await post(server, { baseRevision: 0, action: 'sync', statements: rows(0, 200) })
        expect(response.status).toBe(413)
        expect(response.body.error).toMatch(/too large/i)
        expect(logError).toHaveBeenCalledTimes(1)
        expect(String(logError.mock.calls[0][0])).toContain('413')
    })

    it('answers 400 for a malformed migration descriptor and logs it', async () => {
        const { server, logError } = makeApp()
        const response = await post(server, {
            baseRevision: 0, action: 'legacy-migration', statements: rows(0, 1),
            migration: { id: 'm4', chunk: 0 },
        })
        expect(response.status).toBe(400)
        expect(response.body).toEqual({ error: 'Invalid SQL migration chunk terminator' })
        expect(logError).toHaveBeenCalledTimes(1)
    })

    it('runs auth and the active-session check before it touches the database', async () => {
        const calls: string[] = []
        const { server, relationalSql } = makeApp({
            auth: async (_req: any, res: any) => { calls.push('auth'); res.status(401).end(); return false },
        })
        expect((await post(server, { baseRevision: 0, action: 'sync', statements: rows(0, 1) })).status).toBe(401)
        expect(calls).toEqual(['auth'])
        expect(relationalSql.revision()).toBe(0)

        const denied = makeApp({
            activeSession: (_req: any, res: any) => { res.status(423).json({ error: 'session is not active' }); return false },
        })
        expect((await post(denied.server, { baseRevision: 0, action: 'sync', statements: rows(0, 1) })).status).toBe(423)
        expect(denied.relationalSql.revision()).toBe(0)
    })

    it('serialises commits through the storage queue it was given', async () => {
        const order: string[] = []
        const { server } = makeApp({
            queue: async (operation: () => Promise<unknown>) => {
                order.push('queued')
                const result = await operation()
                order.push('released')
                return result
            },
        })
        await post(server, { baseRevision: 0, action: 'sync', statements: rows(0, 1) })
        expect(order).toEqual(['queued', 'released'])
    })
})
