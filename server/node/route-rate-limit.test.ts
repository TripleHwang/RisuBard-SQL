import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import express from 'express'
import http from 'node:http'
import { rateLimit } from 'express-rate-limit'

const server = readFileSync(new URL('./server.cjs', import.meta.url), 'utf8')

describe('route rate limiting', () => {
    it('limits password attempts without throttling authenticated storage reads', () => {
        expect(server).toContain('const loginRouteLimiter = rateLimit({')
        expect(server).not.toContain('authenticatedRouteLimiter')
        expect(server).not.toMatch(/app\.use\([^\n]*rateLimit/)
    })

    it('uses a dedicated limiter for expensive CharX imports', () => {
        expect(server).toContain('const charxImportLimiter = rateLimit({')
        expect(server).toMatch(/app\.post\('\/api\/charx\/import', charxImportLimiter, createCharXImportHandler\(/)
    })

    it('limits streamed Risum imports and high-volume asset uploads at their routes', () => {
        expect(server).toContain('const risumImportLimiter = rateLimit({')
        expect(server).toContain('const assetUploadLimiter = rateLimit({')
        expect(server).toMatch(/app\.post\('\/api\/risum\/import', risumImportLimiter, createRisumImportHandler\(/)
        expect(server).toMatch(/app\.post\('\/api\/assets\/upload', assetUploadLimiter, createAssetUploadHandler\(/)
    })

    it('caps SQL hydration reads and legacy full-chat saves without a global limiter', () => {
        expect(server).toContain('const sqlReadLimiter = rateLimit({')
        expect(server).toContain('const chatContentWriteLimiter = rateLimit({')
        for (const route of [
            '/api/sql/bootstrap', '/api/sql/root-keys/:rootKey',
            '/api/sql/characters/:characterId', '/api/sql/chats/:chatId/messages',
            '/api/sql/chat-drafts', '/api/sql/chat-drafts/:draftKey', '/api/sql/cold-storage',
            '/api/sql/cold-storage/:archiveId', '/api/sql/revisions', '/api/sql/search/messages',
            '/api/sql/search/characters',
        ]) {
            expect(server).toContain(`app.get('${route}', sqlReadLimiter,`)
        }
        const chatLimiter = server.indexOf('const chatContentWriteLimiter = rateLimit({')
        const chatMiddleware = server.indexOf("app.use('/api/chat-content', chatContentWriteLimiter)")
        const jsonParser = server.indexOf("app.use(express.json({ limit: '100mb' }))")
        expect(chatLimiter).toBeGreaterThanOrEqual(0)
        expect(chatMiddleware).toBeGreaterThan(chatLimiter)
        expect(jsonParser).toBeGreaterThan(chatMiddleware)
        expect(server).toContain("app.post('/api/chat-content/:chaId/:chatIndex', async")
    })

    it('limits exact legacy raw save upload routes', () => {
        const limiter = server.indexOf('const legacySaveImportLimiter = rateLimit({')
        expect(limiter).toBeGreaterThanOrEqual(0)
        expect(server).toContain("app.post('/api/backup/import', legacySaveImportLimiter, async")
        expect(server).toContain("app.post('/api/migrate/save-folder/upload', legacySaveImportLimiter, async")
        expect(server).not.toContain("app.use('/api/backup/import', legacySaveImportLimiter)")
        expect(server).not.toContain("skip: (req) => req.method !== 'POST' || req.path !== '/'")
    })

    it('does not charge backup prepare requests against the exact upload limit', async () => {
        const app = express()
        const limiter = rateLimit({ windowMs: 60_000, max: 1, validate: { xForwardedForHeader: false } })
        app.post('/api/backup/import/prepare', (_req, res) => res.sendStatus(200))
        app.post('/api/backup/import', limiter, (_req, res) => res.sendStatus(200))
        const listener = http.createServer(app)
        await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
        try {
            const port = (listener.address() as { port: number }).port
            const request = (path: string) => fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST' })
            expect((await request('/api/backup/import/prepare')).status).toBe(200)
            expect((await request('/api/backup/import')).status).toBe(200)
            expect((await request('/api/backup/import')).status).toBe(429)
        } finally {
            await new Promise<void>((resolve) => listener.close(() => resolve()))
        }
    })
})
