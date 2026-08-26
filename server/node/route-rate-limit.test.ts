import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

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
            '/api/sql/bootstrap', '/api/sql/characters/:characterId', '/api/sql/chats/:chatId/messages',
            '/api/sql/chat-drafts', '/api/sql/chat-drafts/:draftKey', '/api/sql/cold-storage',
            '/api/sql/cold-storage/:archiveId', '/api/sql/revisions', '/api/sql/search/messages',
            '/api/sql/search/characters',
        ]) {
            expect(server).toContain(`app.get('${route}', sqlReadLimiter,`)
        }
        expect(server).toContain("app.post('/api/chat-content/:chaId/:chatIndex', chatContentWriteLimiter,")
    })
})
