import express from 'express'
import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { httpStatusForError, createExpressErrorResponder } = require('./express-error-response.cjs')

/**
 * The terminal Express error handler.
 *
 * Before this module existed the last handler in server.cjs was three lines
 * that logged nothing and answered 500 to everything. The consequence was not
 * theoretical: a client uploading a migration too large for the server got back
 * `500` with no server-side record, so `SQL commit is too large` reached nobody
 * -- not the user, not the operator, not the log file -- and a user ran in
 * legacy fallback mode for months without a single line anywhere saying why.
 *
 * These tests drive the real handler inside a real express app over a real
 * socket, because the behaviour under test is what a client actually receives.
 */

const servers: http.Server[] = []
afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

type Thrower = (req: express.Request, res: express.Response) => void

function makeApp(thrower: Thrower, logError = vi.fn()) {
    const app = express()
    app.get('/boom', (req, res, next) => {
        try { thrower(req, res) } catch (error) { return next(error) }
        next(new Error('the route did not throw'))
    })
    app.use(createExpressErrorResponder({ logError }))
    const server = http.createServer(app)
    servers.push(server)
    return { server, logError }
}

async function get(server: http.Server, path = '/boom') {
    if (!server.listening) await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as { port: number }
    return await new Promise<{ status: number, body: any }>((resolve, reject) => {
        const request = http.request({ hostname: '127.0.0.1', port, path, method: 'GET' }, response => {
            let text = ''
            response.on('data', chunk => { text += chunk })
            response.on('end', () => resolve({
                status: response.statusCode || 0,
                body: text ? JSON.parse(text) : null,
            }))
        })
        request.on('error', reject)
        request.end()
    })
}

describe('httpStatusForError', () => {
    it('honours the status an error already carries', () => {
        expect(httpStatusForError(Object.assign(new Error('too big'), { status: 413 }))).toBe(413)
        expect(httpStatusForError(Object.assign(new Error('nope'), { statusCode: 403 }))).toBe(403)
        // `status` wins when both are present, matching express's own precedence.
        expect(httpStatusForError(Object.assign(new Error('x'), { status: 413, statusCode: 500 }))).toBe(413)
    })

    it('falls back to 500 for anything that is not a usable error status', () => {
        expect(httpStatusForError(new Error('plain'))).toBe(500)
        expect(httpStatusForError(null)).toBe(500)
        expect(httpStatusForError('a string')).toBe(500)
        // A stray `status` from something that is not an HTTP status must not
        // become the response code -- a 200 here would report a failure as
        // success, which is the failure mode this whole change is about.
        expect(httpStatusForError(Object.assign(new Error('x'), { status: 200 }))).toBe(500)
        expect(httpStatusForError(Object.assign(new Error('x'), { status: 302 }))).toBe(500)
        expect(httpStatusForError(Object.assign(new Error('x'), { status: 1e9 }))).toBe(500)
        expect(httpStatusForError(Object.assign(new Error('x'), { status: '413' }))).toBe(413)
    })
})

describe('terminal express error handler', () => {
    it('answers 413 for a PayloadTooLargeError instead of collapsing it into 500', async () => {
        // Exactly the shape express's body parser raises when a body exceeds
        // its limit: the reason a 54 MB migration upload came back as an
        // indistinguishable 500.
        const payloadTooLarge = Object.assign(new Error('request entity too large'), {
            status: 413, statusCode: 413, type: 'entity.too.large', expose: true,
        })
        const { server } = makeApp(() => { throw payloadTooLarge })
        await expect(get(server)).resolves.toEqual({
            status: 413,
            body: { error: 'request entity too large' },
        })
    })

    it('still answers 500 for an error that carries no status', async () => {
        const { server } = makeApp(() => { throw new Error('something broke') })
        await expect(get(server)).resolves.toEqual({ status: 500, body: { error: 'something broke' } })
    })

    it('reports every failure it answers, with the method, target, status and code', async () => {
        const logError = vi.fn()
        const { server } = makeApp(() => {
            throw Object.assign(new Error('SQL commit is too large'), {
                status: 413, code: 'SQL_COMMIT_TOO_LARGE',
            })
        }, logError)
        await get(server, '/boom?why=1')
        expect(logError).toHaveBeenCalledTimes(1)
        const [line, stack] = logError.mock.calls[0]
        expect(line).toContain('GET')
        expect(line).toContain('/boom?why=1')
        expect(line).toContain('413')
        expect(line).toContain('SQL_COMMIT_TOO_LARGE')
        expect(line).toContain('SQL commit is too large')
        expect(String(stack)).toContain('Error: SQL commit is too large')
    })

    it('reports the failure even when logging itself throws', async () => {
        const logError = vi.fn(() => { throw new Error('the log sink is gone') })
        const { server } = makeApp(() => { throw new Error('something broke') }, logError)
        // A broken log sink must not turn a 500 into a hung socket.
        await expect(get(server)).resolves.toEqual({ status: 500, body: { error: 'something broke' } })
    })

    it('hands a half-written response back to express rather than writing a second one', () => {
        const logError = vi.fn()
        const next = vi.fn()
        const status = vi.fn()
        const error = Object.assign(new Error('too late'), { status: 413 })
        // The response is already on the wire; a second status written over the
        // first would corrupt it, so the only honest move is to hand it back.
        createExpressErrorResponder({ logError })(
            error,
            { method: 'GET', originalUrl: '/boom' } as any,
            { headersSent: true, status } as any,
            next,
        )
        expect(next).toHaveBeenCalledWith(error)
        expect(status).not.toHaveBeenCalled()
    })

    it('defaults to console.error so a standalone operator sees the failure', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            const app = express()
            app.get('/boom', (req, res, next) => next(new Error('unwatched failure')))
            app.use(createExpressErrorResponder({}))
            const server = http.createServer(app)
            servers.push(server)
            await expect(get(server)).resolves.toMatchObject({ status: 500 })
            expect(spy.mock.calls.some(call => String(call[0]).includes('unwatched failure'))).toBe(true)
        } finally {
            spy.mockRestore()
        }
    })
})
