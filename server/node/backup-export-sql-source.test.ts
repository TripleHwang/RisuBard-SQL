/**
 * GET /api/backup/export against a real server process.
 *
 * The user's report, reproduced end to end: import backup state A, chat past it
 * so the live state is A+, export, and get A back. In SQL (metadata-first) mode
 * `save/database/database.bin` stops being written the moment the client
 * migrates — `bootstrap.ts:287` calls `startMetadataPersistence()` and never
 * `saveDb()` — so the file the export used to stream is frozen at the instant
 * of the migration.
 *
 * Nothing here is stubbed. A real `server.cjs` runs in its own process against
 * its own temporary save directory; the backup is imported through
 * `/api/backup/import`, the migration and the later messages go through
 * `/api/sql/commit`, and the assertions are made against the bytes the export
 * endpoint actually writes.
 */
import { Unpackr } from 'msgpackr'
import { afterEach, describe, expect, it } from 'vitest'

import { buildSqlChatMessagesCommit, buildSqlReplaceCommit } from '../../src/ts/storage/sql/sqlCommit'
import { applySqliteCommit } from '../../src/ts/storage/sql/sqliteCommit'
import { SQL_CHAT_HISTORY_AUDIT_KEY, SQL_MIGRATION_MARKER_KEY } from '../../src/ts/storage/sql/nodeSqliteStorage'
import { createClient, type RisuClient } from '../../test/compat/helpers/client'
import { decodeBackup } from '../../test/compat/helpers/decode'
import { encodeBackup } from '../../test/compat/helpers/encode'
import { spawnServer, type ServerHandle } from '../../test/compat/helpers/spawnServer'

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const unpackr = new Unpackr({ int64AsType: 'number', useRecords: false })

const servers: ServerHandle[] = []
afterEach(async () => {
    for (const server of servers.splice(0)) await server.cleanup()
})

async function boot(): Promise<{ server: ServerHandle, client: RisuClient }> {
    const server = await spawnServer()
    servers.push(server)
    return { server, client: await createClient(server.port, server.password) }
}

function encodeRisuSaveLegacy(data: unknown): Buffer {
    // Mirrors utils.cjs: msgpackr with useRecords disabled, behind the raw
    // magic header. The compat seed helper writes backups the same way.
    const { Packr } = require('msgpackr')
    return Buffer.concat([MAGIC_RAW, new Packr({ useRecords: false }).encode(data)])
}

function decodeExportedDatabase(backup: Buffer): any {
    const entry = decodeBackup(backup).find((item) => item.name === 'database.risudat')
    if (!entry) throw new Error('the export carried no database.risudat entry')
    const header = entry.data.subarray(0, MAGIC_RAW.length)
    if (!header.equals(MAGIC_RAW)) {
        throw new Error(`unexpected database.risudat header: ${header.toString('hex')}`)
    }
    return unpackr.decode(entry.data.subarray(MAGIC_RAW.length))
}

/** State A: what the user restores from a backup and then migrates. */
function stateA(): any {
    return {
        apiType: 'openai',
        username: 'reporter',
        maxContext: 4000,
        personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
        botPresets: [],
        botPresetsId: 0,
        modules: [],
        pluginCustomStorage: {},
        characters: [
            {
                chaId: 'char-a',
                type: 'character',
                name: 'Ada',
                image: '',
                desc: 'a description that only the SQL character rows carry',
                firstMessage: 'Hello!',
                chatPage: 0,
                chats: [
                    {
                        id: 'chat-a',
                        name: 'Chat 0',
                        note: '',
                        localLore: [],
                        message: [
                            { role: 'user', data: 'A message one', chatId: 'msg-a1' },
                            { role: 'char', data: 'A message two', chatId: 'msg-a2' },
                        ],
                    },
                ],
            },
        ],
    }
}

async function toStatements(commit: unknown): Promise<{ sql: string, bind: unknown[] }[]> {
    const statements: { sql: string, bind: unknown[] }[] = []
    await applySqliteCommit(commit as never, (sql, bind = []) => {
        statements.push({ sql, bind: bind as unknown[] })
    })
    return statements
}

async function sqlRevision(client: RisuClient): Promise<number> {
    const res = await client.fetch('/api/sql/bootstrap')
    expect(res.ok).toBe(true)
    return (await res.json() as { revision: number }).revision
}

async function postCommit(
    client: RisuClient,
    body: { baseRevision: number, action: string, statements: unknown[] },
): Promise<void> {
    const res = await client.fetch('/api/sql/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`commit failed (${res.status}): ${await res.text()}`)
}

/** Import state A as a backup, exactly as the user did. */
async function importStateA(client: RisuClient): Promise<void> {
    const backup = encodeBackup([{ name: 'database.risudat', data: encodeRisuSaveLegacy(stateA()) }])
    const result = await client.importBackup(backup)
    expect(result.ok).toBe(true)
}

/** Migrate state A into SQL the way `replaceDatabase` does, audit stamp and all. */
async function migrateStateA(client: RisuClient, extraRootUpserts: { key: string, value: unknown }[] = []): Promise<void> {
    const commit = buildSqlReplaceCommit(stateA(), await sqlRevision(client))
    commit.root.upserts.push({
        key: SQL_CHAT_HISTORY_AUDIT_KEY,
        value: { at: new Date().toISOString(), chats: 1, note: 'export-test' },
    })
    for (const upsert of extraRootUpserts) commit.root.upserts.push(upsert)
    await postCommit(client, {
        baseRevision: await sqlRevision(client),
        action: 'replace-all',
        statements: await toStatements(commit),
    })
}

/** The user keeps chatting: two more messages, committed to SQL only. */
async function chatPastStateA(client: RisuClient): Promise<void> {
    const commit = buildSqlChatMessagesCommit(
        'chat-a',
        [
            { role: 'user', data: 'A+ message three', chatId: 'msg-a3' },
            { role: 'char', data: 'A+ message four', chatId: 'msg-a4' },
        ] as never,
        2,
        await sqlRevision(client),
    )
    await postCommit(client, {
        baseRevision: await sqlRevision(client),
        action: 'chat-messages',
        statements: await toStatements(commit),
    })
}

/** An ordinary root-setting write, the kind SQL mode makes constantly. */
async function changeUsernameInSql(client: RisuClient, username: string): Promise<void> {
    const { createEmptySqlCommit } = await import('../../src/ts/storage/sql/sqlCommit')
    const commit = createEmptySqlCommit(await sqlRevision(client), 'sync')
    commit.root.upserts.push({ key: 'username', value: username })
    await postCommit(client, {
        baseRevision: await sqlRevision(client),
        action: 'sync',
        statements: await toStatements(commit),
    })
}

function messagesOf(database: any): string[] {
    return database.characters[0].chats[0].message.map((message: any) => message.data)
}

describe('GET /api/backup/export picks its database source', () => {
    it('exports the live SQL state A+, not the database.bin frozen at state A', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)
        await chatPastStateA(client)

        const exported = decodeExportedDatabase(await client.exportBackup())
        expect(messagesOf(exported)).toEqual([
            'A message one', 'A message two', 'A+ message three', 'A+ message four',
        ])
        // The full character, not the bootstrap summary: the summary carries the
        // name and the image and nothing else.
        expect(exported.characters[0].desc).toBe('a description that only the SQL character rows carry')
        expect(exported.username).toBe('reporter')
        // Storage bookkeeping must never ride along inside an exported database.
        expect(exported).not.toHaveProperty(SQL_CHAT_HISTORY_AUDIT_KEY)
        expect(exported).not.toHaveProperty(SQL_MIGRATION_MARKER_KEY)
    })

    it('sends a content-length that matches the bytes it actually writes', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)
        await chatPastStateA(client)

        const res = await client.fetch('/api/backup/export')
        expect(res.ok).toBe(true)
        const declared = Number(res.headers.get('content-length'))
        const body = Buffer.from(await res.arrayBuffer())
        expect(declared).toBe(body.length)
        // Not the size of the stale file, which is what kvSize() would report.
        expect(messagesOf(decodeExportedDatabase(body))).toHaveLength(4)
    })

    it('exports database.bin on an install that never migrated', async () => {
        const { client } = await boot()
        await importStateA(client)

        const exported = decodeExportedDatabase(await client.exportBackup())
        expect(messagesOf(exported)).toEqual(['A message one', 'A message two'])
        expect(exported.username).toBe('reporter')
    })

    it('exports database.bin while a migration is still in flight', async () => {
        const { client } = await boot()
        await importStateA(client)
        // A SQL database that reads as 'ready' but carries the in-progress
        // marker holds only part of the legacy database, and the client keeps
        // using the legacy source. The export has to reach the same verdict.
        await migrateStateA(client, [{ key: SQL_MIGRATION_MARKER_KEY, value: 'chunk 1 of 4' }])
        await chatPastStateA(client)

        const exported = decodeExportedDatabase(await client.exportBackup())
        expect(messagesOf(exported)).toEqual(['A message one', 'A message two'])
    })

    it('fails loudly instead of shipping a backup it cannot read in full', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)
        await chatPastStateA(client)

        // The character row survives; its relational nodes do not. loadCharacter
        // still answers detailsLoaded: true over an empty object, which is the
        // shape that once got exported as a stub.
        const { DatabaseSync } = await import('node:sqlite')
        const { join } = await import('node:path')
        const server = servers[servers.length - 1]
        const database = new DatabaseSync(join(server.cwd, 'save', 'sql', 'risu-standalone.sqlite3'))
        database.prepare('DELETE FROM character_extension_nodes WHERE character_id = ?').run('char-a')
        database.close()

        const res = await client.fetch('/api/backup/export')
        expect(res.status).toBe(500)
        const body = await res.json() as { error: string }
        expect(body.error).toContain('char-a')
        expect(body.error).toContain('No backup file was written')
    })

    it('builds the settings-only export and its estimate from SQL too', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)
        await chatPastStateA(client)
        // A settings change made after the migration lives only in SQL, exactly
        // like the extra messages do. `database.bin` still says "reporter".
        await changeUsernameInSql(client, 'reporter-after-migrating')

        const estimate = await client.fetch('/api/backup/export/settings-estimate')
        expect(estimate.ok).toBe(true)
        const breakdown = await estimate.json() as { dbBytes: number }
        expect(breakdown.dbBytes).toBeGreaterThan(0)

        const res = await client.fetch('/api/backup/export?mode=settings')
        expect(res.ok).toBe(true)
        const body = Buffer.from(await res.arrayBuffer())
        expect(Number(res.headers.get('content-length'))).toBe(body.length)
        const entry = decodeBackup(body).find((item) => item.name === 'database.risudat')
        expect(entry).toBeDefined()
        // Settings-only is compressed, so decode through the server's own codec.
        const { decodeRisuSave } = require('./utils.cjs')
        const settingsDb = await decodeRisuSave(entry!.data)
        expect(settingsDb.characters).toEqual([])
        expect(settingsDb.username).toBe('reporter-after-migrating')
        expect(settingsDb).not.toHaveProperty(SQL_CHAT_HISTORY_AUDIT_KEY)
    })

    it('keeps the settings-only export on database.bin when SQL never became canonical', async () => {
        const { client } = await boot()
        await importStateA(client)

        const res = await client.fetch('/api/backup/export?mode=settings')
        expect(res.ok).toBe(true)
        const entry = decodeBackup(Buffer.from(await res.arrayBuffer()))
            .find((item) => item.name === 'database.risudat')
        const { decodeRisuSave } = require('./utils.cjs')
        const settingsDb = await decodeRisuSave(entry!.data)
        expect(settingsDb.characters).toEqual([])
        expect(settingsDb.username).toBe('reporter')
    })

    /**
     * The user's loop closed, not just its first half. Asserting that the
     * exported bytes decode to A+ proves the export read SQL; it does not prove
     * the backup is restorable. A rebuilt object that carries a shape the
     * importer mishandles would satisfy every other test here and still hand
     * the user back a broken install on the one day they need the backup.
     */
    it('restores to A+ on a fresh install, so the backup is usable and not just correct', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)
        await chatPastStateA(client)
        const exported = await client.exportBackup()

        // A brand-new server with its own save directory: the recovery path.
        const fresh = await boot()
        expect((await fresh.client.importBackup(exported)).ok).toBe(true)

        const restored = decodeExportedDatabase(await fresh.client.exportBackup())
        expect(messagesOf(restored)).toEqual([
            'A message one', 'A message two', 'A+ message three', 'A+ message four',
        ])
        expect(restored.characters[0].desc).toBe('a description that only the SQL character rows carry')
        expect(restored.username).toBe('reporter')
    })

    it('exports the SQL state through ?target=upstream as well', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)
        await chatPastStateA(client)

        const res = await client.fetch('/api/backup/export?target=upstream')
        expect(res.ok).toBe(true)
        const body = Buffer.from(await res.arrayBuffer())
        expect(Number(res.headers.get('content-length'))).toBe(body.length)
        expect(messagesOf(decodeExportedDatabase(body))).toHaveLength(4)
    })
})

/**
 * Saves a backup into the server's own backups directory and returns it.
 *
 * The endpoint streams NDJSON progress and only names the file in its final
 * `done` line, so the response has to be read to the end before the file can be
 * fetched back.
 */
async function saveServerBackup(client: RisuClient): Promise<Buffer> {
    const res = await client.fetch('/api/backup/server/save', { method: 'POST' })
    expect(res.ok).toBe(true)
    const lines = (await res.text()).trim().split('\n').map(line => JSON.parse(line))
    const done = lines.at(-1)
    expect(done).toMatchObject({ type: 'done', ok: true })
    const download = await client.fetch(`/api/backup/server/download/${done.filename}`)
    expect(download.ok).toBe(true)
    return Buffer.from(await download.arrayBuffer())
}

describe('POST /api/backup/server/save picks the same database source', () => {
    it('saves the live SQL state A+, not the database.bin frozen at state A', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)
        await chatPastStateA(client)

        // This one matters more than the download does. /api/backup/server/restore
        // resets the relational store and re-migrates from the database.risudat
        // it finds, so a saved backup frozen at state A does not just hand back a
        // stale file -- restoring it overwrites the live history with state A.
        const saved = decodeExportedDatabase(await saveServerBackup(client))
        expect(messagesOf(saved)).toEqual([
            'A message one', 'A message two', 'A+ message three', 'A+ message four',
        ])
        expect(saved.characters[0].desc).toBe('a description that only the SQL character rows carry')
        expect(saved).not.toHaveProperty(SQL_CHAT_HISTORY_AUDIT_KEY)
        expect(saved).not.toHaveProperty(SQL_MIGRATION_MARKER_KEY)
    })

    it('saves database.bin on an install that never migrated', async () => {
        const { client } = await boot()
        await importStateA(client)

        const saved = decodeExportedDatabase(await saveServerBackup(client))
        expect(messagesOf(saved)).toEqual(['A message one', 'A message two'])
    })
})

/** Opens the running server's own SQLite file. */
async function openLiveSqlite(): Promise<any> {
    const { DatabaseSync } = await import('node:sqlite')
    const { join } = await import('node:path')
    const server = servers[servers.length - 1]
    return new DatabaseSync(join(server.cwd, 'save', 'sql', 'risu-standalone.sqlite3'))
}

describe('the export refuses the other shapes of a partial read', () => {
    it('refuses a chat whose per-chat settings cannot be read, however complete its history is', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)
        await chatPastStateA(client)

        // The chats row survives and every message survives, so the history
        // reads back whole and every count agrees. Only the chat's own settings
        // -- memory config, bound persona, modules, script state -- are gone.
        // loadChat answers `{}` decorated with the summary columns, which is the
        // same shape that once shipped a character as a stub.
        const database = await openLiveSqlite()
        database.prepare('DELETE FROM chat_extension_nodes WHERE chat_id = ?').run('chat-a')
        database.close()

        const res = await client.fetch('/api/backup/export')
        expect(res.status).toBe(500)
        const body = await res.json() as { error: string }
        expect(body.error).toContain('chat-a')
        expect(body.error).toContain('No backup file was written')
    })

    it('still gives a settings-only export when a character is unreadable', async () => {
        const { client } = await boot()
        await importStateA(client)
        await migrateStateA(client)

        const database = await openLiveSqlite()
        database.prepare('DELETE FROM character_extension_nodes WHERE character_id = ?').run('char-a')
        database.close()

        // Settings-only throws the character library away anyway. Seeding a
        // fresh instance from a damaged one is what this export is for, so it
        // must not fail on a character it was never going to carry.
        const estimate = await client.fetch('/api/backup/export/settings-estimate')
        expect(estimate.ok).toBe(true)
        const res = await client.fetch('/api/backup/export?mode=settings')
        expect(res.ok).toBe(true)
        const entry = decodeBackup(Buffer.from(await res.arrayBuffer()))
            .find((item) => item.name === 'database.risudat')
        const { decodeRisuSave } = require('./utils.cjs')
        expect((await decodeRisuSave(entry!.data)).characters).toEqual([])
        // The full export still refuses it.
        expect((await client.fetch('/api/backup/export')).status).toBe(500)
    })

    it('refuses to hand back a backup with no database in it at all', async () => {
        const { client } = await boot()

        // Nothing imported and nothing migrated: SQL is not canonical and there
        // is no database.bin. kvSize answers 0 for the missing key, and the
        // write is guarded on that size, so this used to be a well-formed 200
        // zip of assets with no database.risudat -- discovered only when a
        // restore rejected it.
        const res = await client.fetch('/api/backup/export')
        expect(res.status).toBe(500)
        expect((await res.json() as { error: string }).error).toContain('No database to export')
    })
})
