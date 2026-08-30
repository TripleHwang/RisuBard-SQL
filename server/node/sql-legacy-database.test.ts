/**
 * Rebuilding the legacy database object out of SQL, for the backup export.
 *
 * THE DEFECT THESE HOLD THE LINE ON
 *
 * After a standalone install migrates, the client boots metadata-first and
 * `saveDb()` is never called again, so `save/database/database.bin` is frozen
 * at the instant of the migration. `GET /api/backup/export` put that frozen
 * file into the backup, so a user who imported state A, chatted up to A+ and
 * exported got A back. Reported from real use, not hypothesised.
 *
 * Every database here is built through the REAL path a migration takes:
 * `buildSqlReplaceCommit` -> `applySqliteCommit` -> `relationalSql.commit()`,
 * the same three functions the client and server actually run. Five of the six
 * defects this codebase has shipped in this area survived a test suite that
 * hand-built its fixtures.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { buildSqlChatMessagesCommit, buildSqlReplaceCommit } from '../../src/ts/storage/sql/sqlCommit'
import { applySqliteCommit } from '../../src/ts/storage/sql/sqliteCommit'

const { createRelationalSqlite } = require('./relational-sqlite.cjs')
const {
    SQL_MIGRATION_MARKER_KEY,
    SQL_CHAT_HISTORY_AUDIT_KEY,
    buildLegacyDatabaseFromSql,
    sqlBootstrapIsCanonical,
} = require('./sql-legacy-database.cjs')

type Statement = { sql: string, bind: unknown[] }

interface Storage {
    databasePath: string
    revision(): number
    bootstrap(options?: unknown): any
    loadCharacter(id: string): any
    loadChat(id: string): any
    loadChatMessages(id: string, before?: number, limit?: number): any
    commit(payload: unknown): { revision: number, initialized: boolean }
    close(): void
}

const roots: string[] = []
const open: Storage[] = []
afterEach(() => {
    for (const storage of open.splice(0)) { try { storage.close() } catch { /* already closed */ } }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function openStorage(): Storage {
    const root = mkdtempSync(join(tmpdir(), 'risu-sql-export-'))
    roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root }) as Storage
    open.push(storage)
    return storage
}

async function toStatements(commit: unknown): Promise<Statement[]> {
    const statements: Statement[] = []
    await applySqliteCommit(commit as never, (sql, bind = []) => { statements.push({ sql, bind: bind as unknown[] }) })
    return statements
}

/**
 * Migrate a legacy database into SQL exactly the way `replaceDatabase` does:
 * a replace-all commit carrying the chat-history audit stamp, which is the
 * fact that makes the result readable as canonical.
 */
async function migrate(storage: Storage, database: unknown): Promise<void> {
    const commit = buildSqlReplaceCommit(database as never, storage.revision())
    commit.root.upserts.push({
        key: SQL_CHAT_HISTORY_AUDIT_KEY,
        value: { at: new Date().toISOString(), chats: 0, note: 'test-migration' },
    })
    storage.commit({
        baseRevision: storage.revision(),
        action: 'replace-all',
        statements: await toStatements(commit),
    })
}

function legacyDatabaseA(): any {
    return {
        username: 'tester',
        formatingOrder: ['main', 'personaPrompt'],
        modules: [{ id: 'mod-1', name: 'Module One', assets: [] }],
        botPresets: [{ id: 'preset-1', name: 'Preset One', apiType: 'openrouter' }],
        botPresetsId: 0,
        pluginCustomStorage: { 'plugin-a': { counter: 3 } },
        characters: [
            {
                chaId: 'char-1',
                type: 'character',
                name: 'Ada',
                image: 'ada.png',
                desc: 'a long description that only lives in the extension nodes',
                globalLore: [{ key: 'lore-key', content: 'lore content' }],
                chats: [
                    {
                        id: 'chat-1',
                        name: 'First chat',
                        note: 'chat note',
                        fmIndex: -1,
                        message: [
                            { role: 'user', data: 'message one', chatId: 'msg-1' },
                            { role: 'char', data: 'message two', chatId: 'msg-2' },
                        ],
                    },
                ],
            },
        ],
    }
}

function chatOf(database: any, characterIndex = 0, chatIndex = 0): any {
    return database.characters[characterIndex].chats[chatIndex]
}

describe('sqlBootstrapIsCanonical', () => {
    it('mirrors the client rule: ready, no in-progress marker, audit stamp present', () => {
        const ready = { status: 'ready', settings: { [SQL_CHAT_HISTORY_AUDIT_KEY]: { chats: 0 } } }
        expect(sqlBootstrapIsCanonical(ready)).toBe(true)
    })

    it('rejects a database that is not ready', () => {
        expect(sqlBootstrapIsCanonical({
            status: 'empty',
            settings: { [SQL_CHAT_HISTORY_AUDIT_KEY]: { chats: 0 } },
        })).toBe(false)
    })

    it('rejects a database carrying the migration-in-progress marker', () => {
        expect(sqlBootstrapIsCanonical({
            status: 'ready',
            settings: {
                [SQL_CHAT_HISTORY_AUDIT_KEY]: { chats: 0 },
                [SQL_MIGRATION_MARKER_KEY]: 'chunk 3 of 18',
            },
        })).toBe(false)
    })

    it('rejects a database with no chat-history audit stamp', () => {
        expect(sqlBootstrapIsCanonical({ status: 'ready', settings: {} })).toBe(false)
    })
})

describe('buildLegacyDatabaseFromSql: the live SQL state, not the frozen file', () => {
    it('returns null for a database that was never migrated, so database.bin stays the source', () => {
        const storage = openStorage()
        expect(buildLegacyDatabaseFromSql(storage)).toBeNull()
    })

    it('returns null while a migration is still in flight', async () => {
        const storage = openStorage()
        const database = legacyDatabaseA()
        const commit = buildSqlReplaceCommit(database, storage.revision())
        // The marker without the audit stamp is what a half-applied migration
        // leaves behind, and it is the reading that keeps database.bin canonical.
        commit.root.upserts.push({ key: SQL_MIGRATION_MARKER_KEY, value: 'chunk 1 of 4' })
        storage.commit({
            baseRevision: storage.revision(),
            action: 'replace-all',
            statements: await toStatements(commit),
        })
        expect(storage.bootstrap().status).toBe('ready')
        expect(buildLegacyDatabaseFromSql(storage)).toBeNull()
    })

    it('returns null for a migration written without the chat-history audit stamp', async () => {
        const storage = openStorage()
        const commit = buildSqlReplaceCommit(legacyDatabaseA(), storage.revision())
        storage.commit({
            baseRevision: storage.revision(),
            action: 'replace-all',
            statements: await toStatements(commit),
        })
        expect(storage.bootstrap().status).toBe('ready')
        expect(buildLegacyDatabaseFromSql(storage)).toBeNull()
    })

    it('rebuilds settings, presets, plugin storage, characters and full histories', async () => {
        const storage = openStorage()
        await migrate(storage, legacyDatabaseA())

        const rebuilt = buildLegacyDatabaseFromSql(storage)
        expect(rebuilt).not.toBeNull()
        expect(rebuilt.username).toBe('tester')
        expect(rebuilt.formatingOrder).toEqual(['main', 'personaPrompt'])
        expect(rebuilt.modules).toEqual([{ id: 'mod-1', name: 'Module One', assets: [] }])
        expect(rebuilt.pluginCustomStorage).toEqual({ 'plugin-a': { counter: 3 } })
        expect(rebuilt.botPresets.map((preset: any) => preset.id)).toEqual(['preset-1'])
        expect(rebuilt.botPresetsId).toBe(0)

        expect(rebuilt.characters).toHaveLength(1)
        const character = rebuilt.characters[0]
        expect(character.chaId).toBe('char-1')
        expect(character.name).toBe('Ada')
        // The bootstrap summary carries none of this; only loadCharacter does.
        expect(character.desc).toBe('a long description that only lives in the extension nodes')
        expect(character.globalLore).toEqual([{ key: 'lore-key', content: 'lore content' }])
        expect(character).not.toHaveProperty('detailsLoaded')

        expect(character.chats).toHaveLength(1)
        const chat = character.chats[0]
        expect(chat.id).toBe('chat-1')
        expect(chat.fmIndex).toBe(-1)
        expect(chat.message.map((message: any) => message.data)).toEqual(['message one', 'message two'])
        for (const key of ['messageTotal', 'messagesLoaded', 'messagesFullyLoaded', 'detailsLoaded']) {
            expect(chat).not.toHaveProperty(key)
        }
    })

    it('never leaks the storage bookkeeping keys into the exported object', async () => {
        const storage = openStorage()
        await migrate(storage, legacyDatabaseA())
        const rebuilt = buildLegacyDatabaseFromSql(storage)
        expect(rebuilt).not.toHaveProperty(SQL_CHAT_HISTORY_AUDIT_KEY)
        expect(rebuilt).not.toHaveProperty(SQL_MIGRATION_MARKER_KEY)
        expect(rebuilt).not.toHaveProperty('activeBotPresetId')
    })

    /**
     * The user's report, written literally: import state A, chat more so the
     * live state is A+, export, and get A back.
     */
    it('exports A+ after the user chats past the migrated state A', async () => {
        const storage = openStorage()
        const stateA = legacyDatabaseA()
        await migrate(storage, stateA)

        // What the running app does on every new message: one ordinary commit,
        // never a rewrite of database.bin.
        const newMessages = [
            { role: 'user', data: 'message three', chatId: 'msg-3' },
            { role: 'char', data: 'message four', chatId: 'msg-4' },
        ]
        const commit = buildSqlChatMessagesCommit('chat-1', newMessages as never, 2, storage.revision())
        storage.commit({
            baseRevision: storage.revision(),
            action: 'chat-messages',
            statements: await toStatements(commit),
        })

        const rebuilt = buildLegacyDatabaseFromSql(storage)
        expect(chatOf(rebuilt).message.map((message: any) => message.data)).toEqual([
            'message one', 'message two', 'message three', 'message four',
        ])
        // The object the frozen database.bin holds is still exactly state A.
        expect(chatOf(stateA).message).toHaveLength(2)
    })

    /**
     * `botPresetsId` is rebuilt as `Math.max(0, findIndex(activeBotPresetId))`,
     * so an index of 0 and a lookup that found nothing (-1) produce the same
     * answer. A one-preset fixture therefore cannot tell a working conversion
     * from a broken one; only a non-zero index can.
     */
    it('restores the active bot preset by index, not by falling back to the first', async () => {
        const storage = openStorage()
        const database = legacyDatabaseA()
        database.botPresets = [
            { id: 'preset-0', name: 'Zero' },
            { id: 'preset-1', name: 'One' },
            { id: 'preset-2', name: 'Two' },
        ]
        database.botPresetsId = 2
        await migrate(storage, database)

        const rebuilt = buildLegacyDatabaseFromSql(storage)
        expect(rebuilt.botPresets.map((preset: any) => preset.id)).toEqual([
            'preset-0', 'preset-1', 'preset-2',
        ])
        expect(rebuilt.botPresetsId).toBe(2)
        // The SQL spelling of the same fact must not ride along into the export.
        expect(rebuilt).not.toHaveProperty('activeBotPresetId')
    })

    it('pages a history that is longer than one message page', async () => {
        const storage = openStorage()
        const database = legacyDatabaseA()
        // 250 crosses MAX_MESSAGE_PAGE_LIMIT (100) twice, so the assembled
        // history is three pages deep and its order is a real result.
        chatOf(database).message = Array.from({ length: 250 }, (_unused, index) => ({
            role: index % 2 === 0 ? 'user' : 'char',
            data: `message ${index}`,
            chatId: `msg-${index}`,
        }))
        await migrate(storage, database)

        const rebuilt = buildLegacyDatabaseFromSql(storage)
        const messages = chatOf(rebuilt).message
        expect(messages).toHaveLength(250)
        expect(messages.map((message: any) => message.data)).toEqual(
            Array.from({ length: 250 }, (_unused, index) => `message ${index}`),
        )
    })
})

describe('buildLegacyDatabaseFromSql: incomplete reads abort the export', () => {
    /**
     * A short read reported as a complete one. This is the shape of the defect
     * that shipped as an evicted chat, a windowed chat and a stub migration:
     * the pager says "that is all" while the row count says otherwise. The
     * store underneath is real; only that one answer is falsified.
     */
    it('aborts when a chat\'s pages do not add up to its reported total', async () => {
        const storage = openStorage()
        const database = legacyDatabaseA()
        chatOf(database).message = Array.from({ length: 150 }, (_unused, index) => ({
            role: 'user', data: `message ${index}`, chatId: `msg-${index}`,
        }))
        await migrate(storage, database)

        const truncating = Object.create(storage) as Storage
        let pageCount = 0
        truncating.loadChatMessages = (id: string, before?: number, limit?: number) => {
            const page = storage.loadChatMessages(id, before, limit)
            if (page && ++pageCount === 1) return { ...page, hasMore: false }
            return page
        }

        expect(() => buildLegacyDatabaseFromSql(truncating)).toThrowError(
            /chat "First chat" \(chat-1\).*holds 150 message\(s\) in SQL but only 100 could be read back/s,
        )
    })

    it('aborts when a chat changes size while it is being read', async () => {
        const storage = openStorage()
        const database = legacyDatabaseA()
        chatOf(database).message = Array.from({ length: 150 }, (_unused, index) => ({
            role: 'user', data: `message ${index}`, chatId: `msg-${index}`,
        }))
        await migrate(storage, database)

        // A real concurrent writer: the same SQLite file, a second connection,
        // a real DELETE between the first page and the second.
        const racing = Object.create(storage) as Storage
        let pageCount = 0
        racing.loadChatMessages = (id: string, before?: number, limit?: number) => {
            const page = storage.loadChatMessages(id, before, limit)
            if (++pageCount === 1) {
                const other = new DatabaseSync(storage.databasePath)
                other.prepare('DELETE FROM messages WHERE chat_id = ? AND position < 5').run('chat-1')
                other.close()
            }
            return page
        }

        expect(() => buildLegacyDatabaseFromSql(racing)).toThrowError(
            /chat "First chat" \(chat-1\).*changed size while it was being read/s,
        )
    })

    it('aborts when a character cannot be loaded, naming it', async () => {
        const storage = openStorage()
        await migrate(storage, legacyDatabaseA())

        // The character is listed by bootstrap and then really removed from the
        // file before it is loaded — the same gap the two calls leave open.
        const racing = Object.create(storage) as Storage
        racing.bootstrap = (options?: unknown) => {
            const payload = storage.bootstrap(options)
            const other = new DatabaseSync(storage.databasePath)
            other.prepare('DELETE FROM characters WHERE id = ?').run('char-1')
            other.close()
            return payload
        }

        expect(() => buildLegacyDatabaseFromSql(racing)).toThrowError(
            /character "Ada" \(char-1\) could not be loaded from SQL/,
        )
    })

    /**
     * The character row survives but its relational nodes do not, so
     * `loadCharacter` hands back `{}` decorated with `detailsLoaded: true`.
     * Nothing in that answer says it is a stub; it once got exported as one.
     */
    it('aborts on a character whose relational nodes are missing', async () => {
        const storage = openStorage()
        await migrate(storage, legacyDatabaseA())

        const other = new DatabaseSync(storage.databasePath)
        other.prepare('DELETE FROM character_extension_nodes WHERE character_id = ?').run('char-1')
        other.close()

        expect(() => buildLegacyDatabaseFromSql(storage)).toThrowError(
            /character "Ada" \(char-1\) rebuilt to a character carrying no data at all/,
        )
    })

    it('aborts when a chat row cannot be loaded, naming it and its character', async () => {
        const storage = openStorage()
        await migrate(storage, legacyDatabaseA())

        const racing = Object.create(storage) as Storage
        racing.loadCharacter = (id: string) => {
            const loaded = storage.loadCharacter(id)
            const other = new DatabaseSync(storage.databasePath)
            other.prepare('DELETE FROM chats WHERE id = ?').run('chat-1')
            other.close()
            return loaded
        }

        expect(() => buildLegacyDatabaseFromSql(racing)).toThrowError(
            /chat "First chat" \(chat-1\) of character "Ada" \(char-1\) could not be loaded from SQL/,
        )
    })

    it('aborts when a root key is registered but holds no relational nodes', async () => {
        const storage = openStorage()
        await migrate(storage, legacyDatabaseA())

        const other = new DatabaseSync(storage.databasePath)
        other.prepare('DELETE FROM setting_extension_nodes WHERE setting_key = ?').run('modules')
        other.close()

        expect(() => buildLegacyDatabaseFromSql(storage)).toThrowError(
            /root key\(s\) modules are registered in SQL but hold no relational nodes/,
        )
    })

    it('carries a 500 status so the export fails loudly instead of shipping a short file', async () => {
        const storage = openStorage()
        await migrate(storage, legacyDatabaseA())
        const other = new DatabaseSync(storage.databasePath)
        other.prepare('DELETE FROM character_extension_nodes WHERE character_id = ?').run('char-1')
        other.close()

        try {
            buildLegacyDatabaseFromSql(storage)
            expect.unreachable('the incomplete read should have thrown')
        } catch (error) {
            expect((error as { code?: string }).code).toBe('SQL_EXPORT_INCOMPLETE')
            expect((error as { status?: number }).status).toBe(500)
            expect((error as Error).message).toContain('No backup file was written')
        }
    })
})
