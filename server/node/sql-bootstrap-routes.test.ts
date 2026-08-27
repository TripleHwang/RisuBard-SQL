import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('bounded SQL read routes', () => {
    it('registers authenticated bounded SQL routes without replacing snapshot recovery', () => {
        const source = readFileSync('server/node/server.cjs', 'utf8')

        expect(source).toContain("app.get('/api/sql/bootstrap'")
        expect(source).toContain("app.get('/api/sql/deferred-bootstrap'")
        expect(source).toContain("app.get('/api/sql/characters/:characterId'")
        expect(source).toContain("app.post('/api/sql/characters/:characterId/repair', sqlMigrationLimiter")
        expect(source).toContain("kvGet('database/pre-sql-migration-v1.bin')")
        expect(source).toContain('characterBodyCollapsed')
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

    it('keeps replacement generations and character repair recovery safety-bounded', () => {
        const source = readFileSync('server/node/server.cjs', 'utf8')
        const backupKey = "'database/pre-sql-migration-v1.bin'"
        const importStart = source.indexOf('async function importBackupFromSource')
        const importReset = source.indexOf('relationalSql.reset()', importStart)
        const importDelete = source.lastIndexOf(`kvDel(${backupKey})`, importReset)
        const replacementStart = source.indexOf('async function applyLegacySaveReplacement')
        const replacementReset = source.indexOf('relationalSql.reset()', replacementStart)
        const replacementDelete = source.lastIndexOf(`kvDel(${backupKey})`, replacementReset)

        expect(source.indexOf('if (!checkActiveSession(req, res)) return;', source.indexOf("app.post('/api/sql/characters/:characterId/repair'"))).toBeGreaterThan(source.indexOf("app.post('/api/sql/characters/:characterId/repair'"))
        expect(importDelete).toBeGreaterThan(importStart)
        expect(importDelete).toBeLessThan(importReset)
        expect(replacementDelete).toBeGreaterThan(replacementStart)
        expect(replacementDelete).toBeLessThan(replacementReset)
        expect(source).toContain("if (!kvGet('database/pre-sql-migration-v1.bin')) kvSet('database/pre-sql-migration-v1.bin', raw)")
        expect(source).toContain("require('./sql-repair-decode.cjs')")
    })
})
