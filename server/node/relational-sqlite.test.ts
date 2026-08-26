import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { createRelationalSqlite, statementTable } = require('./relational-sqlite.cjs')

const roots: string[] = []
const readerStorages: { close(): void }[] = []
afterEach(() => {
  for (const storage of readerStorages.splice(0)) storage.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('server relational SQLite', () => {
  it('returns bootstrap summaries without message extension rows', () => {
    const storage = seededReaderStorage()

    const result = storage.bootstrap()

    expect(result.characters[0]).toMatchObject({
      chaId: 'character-1',
      detailsLoaded: false,
    })
    expect(result.characters[0].chats[0]).toMatchObject({
      id: 'chat-1',
      message: [],
      messagesLoaded: false,
    })
    expect(JSON.stringify(result)).not.toContain('message_extension_nodes')
  })

  it('loads full character detail and a bounded chat summary', () => {
    const storage = seededReaderStorage()

    expect(storage.loadCharacter('character-1')).toMatchObject({
      character: {
        chaId: 'character-1',
        detailsLoaded: true,
        greeting: 'Hello',
        chats: [{ id: 'chat-1', message: [], messagesLoaded: false }],
      },
    })
    expect(storage.loadChat('chat-1')).toMatchObject({
      chat: { id: 'chat-1', note: 'summary', message: [], messagesLoaded: false },
    })
    expect(storage.loadCharacter('missing')).toBeNull()
    expect(storage.loadChat('missing')).toBeNull()
  })

  it('returns newest messages as an ascending reverse-cursor page', () => {
    const storage = seededReaderStorage()

    expect(storage.loadChatMessages('chat-1', undefined, 2)).toMatchObject({
      messages: [{ chatId: 'message-2' }, { chatId: 'message-3' }],
      nextBefore: 1,
      total: 3,
      hasMore: true,
    })
  })

  it('clamps page limit to 100 and rejects invalid cursors', () => {
    const storage = seededReaderStorage()

    expect(storage.loadChatMessages('chat-1', undefined, 999).messages).toHaveLength(3)
    expect(() => storage.loadChatMessages('chat-1', -1, 40)).toThrow(/before/i)
    expect(() => storage.loadChatMessages('chat-1', 1.5, 40)).toThrow(/before/i)
  })

  it('commits bounded statements with optimistic revisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-relational-'))
    roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root })

    expect(storage.dump().status).toBe('empty')
    expect(storage.commit({
      baseRevision: 0,
      action: 'test',
      statements: [{
        sql: `INSERT INTO plugin_custom_storage (key, value, updated_at)
              VALUES (?, ?, datetime('now'))`,
        bind: ['pagefold.config.v1', '{"provider":"google"}'],
      }],
    })).toEqual({ revision: 1 })
    expect(storage.dump().tables.plugin_custom_storage).toEqual([
      expect.objectContaining({ key: 'pagefold.config.v1' }),
    ])
    expect(() => storage.commit({ baseRevision: 0, statements: [] })).toThrow(
      'SQL revision conflict',
    )
    storage.close()
  })

  it('rejects DDL, metadata writes, comments and stacked statements', () => {
    expect(() => statementTable('DROP TABLE messages')).toThrow()
    expect(() => statementTable('UPDATE system_storage_meta SET revision = 9')).toThrow()
    expect(() => statementTable('DELETE FROM messages; DROP TABLE chats')).toThrow()
    expect(() => statementTable('DELETE FROM messages -- all')).toThrow()
  })

  it('archives SQL before a compatibility import and reopens empty', () => {
    const root = mkdtempSync(join(tmpdir(), 'risu-relational-reset-'))
    roots.push(root)
    const storage = createRelationalSqlite({ dataRoot: root })
    storage.commit({
      baseRevision: 0,
      action: 'seed',
      statements: [{
        sql: 'INSERT INTO plugin_custom_storage (key, value) VALUES (?, ?)',
        bind: ['preserved', 'true'],
      }],
    })

    const reset = storage.reset()
    expect(reset.previousRevision).toBe(1)
    expect(reset.archivedPath).toContain('sql-pre-compat-import-')
    expect(storage.dump()).toMatchObject({ status: 'empty', revision: 0 })
    storage.close()
  })
})

function seededReaderStorage() {
  const root = mkdtempSync(join(tmpdir(), 'risu-relational-reader-'))
  roots.push(root)
  const storage = createRelationalSqlite({ dataRoot: root })
  const node = (table: string, ownerColumn: string, owner: string, value: Record<string, unknown>) => ({
    sql: `INSERT INTO ${table} (${ownerColumn}, node_id, parent_node_id, node_order, object_key, value_type, text_value)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    bind: [owner, 0, null, 0, null, 'object', null],
  })
  storage.commit({
    baseRevision: 0,
    action: 'seed-readers',
    statements: [
      { sql: 'INSERT INTO system_settings (key, domain, value_type) VALUES (?, ?, ?)', bind: ['theme', 'database', 'string'] },
      { sql: 'INSERT INTO setting_extension_nodes (setting_key, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?)', bind: ['theme', 0, null, 0, null, 'string', 'dark'] },
      { sql: 'INSERT INTO characters (id, position, kind, name) VALUES (?, ?, ?, ?)', bind: ['character-1', 0, 'character', 'Alice'] },
      node('character_extension_nodes', 'character_id', 'character-1', {}),
      { sql: 'INSERT INTO character_extension_nodes (character_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?)', bind: ['character-1', 1, 0, 0, 'greeting', 'string', 'Hello'] },
      { sql: 'INSERT INTO chats (id, character_id, position, name, note) VALUES (?, ?, ?, ?, ?)', bind: ['chat-1', 'character-1', 0, 'Chat', 'summary'] },
      node('chat_extension_nodes', 'chat_id', 'chat-1', {}),
      { sql: 'INSERT INTO chat_extension_nodes (chat_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?)', bind: ['chat-1', 1, 0, 0, 'custom', 'string', 'chat detail'] },
      ...[1, 2, 3].flatMap((position) => [
        { sql: 'INSERT INTO messages (chat_id, id, position, role) VALUES (?, ?, ?, ?)', bind: ['chat-1', `message-${position}`, position - 1, 'user'] },
        { sql: 'INSERT INTO message_extension_nodes (chat_id, message_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', bind: ['chat-1', `message-${position}`, 0, null, 0, null, 'object', null] },
        { sql: 'INSERT INTO message_extension_nodes (chat_id, message_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', bind: ['chat-1', `message-${position}`, 1, 0, 0, 'content', 'string', `message ${position}`] },
      ]),
    ],
  })
  readerStorages.push(storage)
  return storage
}
