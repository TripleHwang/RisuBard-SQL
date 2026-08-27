import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('bounded SQL read routes', () => {
    it('registers authenticated bounded SQL routes without replacing snapshot recovery', () => {
        const source = readFileSync('server/node/server.cjs', 'utf8')

        expect(source).toContain("app.get('/api/sql/bootstrap'")
        expect(source).toContain("app.get('/api/sql/deferred-bootstrap'")
        expect(source).toContain("app.get('/api/sql/characters/:characterId'")
        expect(source).toContain("app.get('/api/sql/chats/:chatId'")
        expect(source).toContain("app.get('/api/sql/chats/:chatId/messages'")
        expect(source).toContain("app.get('/api/sql/snapshot'")
        expect(source).toContain('relationalSql.loadChatMessages')
        expect(source).toContain('relationalSql.loadChat(id)')
        expect(source).toContain("require('./sql-read-route-params.cjs')")
        expect(source).toContain('normalizeSqlMessagePageQuery(req.query)')
        expect(source).toContain("app.get('/api/sql/chat-drafts'")
        expect(source).toContain("app.get('/api/sql/chat-drafts/:draftKey'")
        expect(source).toContain("app.get('/api/sql/cold-storage'")
        expect(source).toContain("app.get('/api/sql/cold-storage/:archiveId'")
        expect(source).toContain("app.get('/api/sql/revisions'")
        expect(source).toContain("app.get('/api/sql/search/messages'")
        expect(source).toContain("app.get('/api/sql/search/characters'")
        expect(source).toContain('normalizeSqlCharacterSearchQuery(req.query)')
        expect(source).toContain('normalizeSqlAncillaryPageQuery(req.query)')
        expect(source).toContain("'Cache-Control', 'private, no-cache'")
        expect(source).toContain('sql-bootstrap-${payload.revision}-${payload.migrationState}')
        expect(source).toContain("app.post('/api/sql/migrate-legacy', sqlMigrationLimiter")
    })
})
