import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
    expect(result.botPresets).toEqual([
      { name: 'First', id: 'preset-1' },
      { name: 'Second', id: 'preset-2' },
    ])
    expect(JSON.parse(JSON.stringify(result.pluginCustomStorage))).toEqual({
      'pagefold.config.v1': { provider: 'google' },
      ['__proto__']: { safelyStored: true },
    })
    expect(JSON.stringify(result)).not.toContain('message_extension_nodes')
    expect(result.settings).toMatchObject({
      theme: 'dark',
      moduleSetting: { enabled: true },
    })
  })

  it('reads ancillary SQL data without dumping messages or cold archives', () => {
    const storage = seededReaderStorage()

    expect(storage.getChatDraft('character-1/chat-1')).toEqual({ m: 'draft', t: '번역' })
    expect(storage.getChatDraft('missing')).toBeNull()
    const firstDraftPage = storage.listChatDraftKeys(undefined, 100)
    const secondDraftPage = storage.listChatDraftKeys(firstDraftPage.nextAfter, 100)
    expect(firstDraftPage).toMatchObject({ keys: expect.any(Array), hasMore: true })
    expect(secondDraftPage).toMatchObject({ hasMore: false, nextAfter: null })
    expect([...firstDraftPage.keys, ...secondDraftPage.keys]).toEqual([
      'character-1/chat-1',
      ...Array.from({ length: 101 }, (_, index) => `draft-${String(index).padStart(3, '0')}`),
    ])

    const firstColdPage = storage.listColdStorageItems(undefined, 100)
    const secondColdPage = storage.listColdStorageItems(firstColdPage.nextAfter, 100)
    expect(firstColdPage).toMatchObject({ items: expect.any(Array), hasMore: true })
    expect(secondColdPage).toMatchObject({ hasMore: false, nextAfter: null })
    const coldItems = [...firstColdPage.items, ...secondColdPage.items]
    expect(coldItems).toHaveLength(102)
    expect(new Set(coldItems)).toHaveLength(102)
    expect(coldItems).toEqual([...coldItems].sort())
    expect(storage.getColdStorageItem('archive-1')).toEqual({ archived: ['message-1'] })
    expect(storage.getColdStorageItem('missing')).toBeNull()

    expect(storage.listRevisions(999)).toHaveLength(1)
    expect(storage.searchMessages('message', 999)).toEqual([
      expect.objectContaining({
        storageState: 'active', characterId: 'character-1', characterName: 'Alice',
        chatId: 'chat-1', chatName: 'Chat', messageId: 'message-3', snippet: 'message 3',
      }),
      expect.objectContaining({ messageId: 'message-2' }),
      expect.objectContaining({ messageId: 'message-1' }),
    ])
    expect(storage.searchCharactersByName('ali', 999)).toEqual([
      { id: 'character-1', name: 'Alice', image: null, kind: 'character' },
    ])
    expect(storage.searchCharactersByTag('fantasy', 999)).toEqual([
      { id: 'character-1', name: 'Alice', image: null, kind: 'character' },
    ])
    expect(storage.searchMessages('%_\\', 100)).toEqual([
      expect.objectContaining({ messageId: 'message-1', snippet: 'message 1 100%_\\' }),
    ])
    expect(storage.searchCharactersByName('_%', 100)).toEqual([
      { id: 'character-literal', name: 'Literal_%', image: null, kind: 'character' },
    ])
    expect(storage.searchCharactersByTag('_%', 100)).toEqual([
      { id: 'character-1', name: 'Alice', image: null, kind: 'character' },
    ])
  })

  it('rejects unsafe ancillary read keys and queries while clamping limits', () => {
    const storage = seededReaderStorage()
    const overlong = 'x'.repeat(257)

    expect(() => storage.getChatDraft(overlong)).toThrow(/key/i)
    expect(() => storage.getColdStorageItem(overlong)).toThrow(/key/i)
    expect(() => storage.searchMessages('   ', 1)).toThrow(/query/i)
    expect(() => storage.searchMessages(overlong, 1)).toThrow(/query/i)
    expect(() => storage.searchCharactersByName(overlong, 1)).toThrow(/query/i)
    expect(() => storage.searchCharactersByTag(overlong, 1)).toThrow(/query/i)
    expect(storage.searchMessages('message', 0)).toHaveLength(1)
  })

  it('bounds message search to its newest-row scan budget before filtering', () => {
    const source = readFileSync('server/node/relational-sqlite.cjs', 'utf8')

    expect(source).toContain('const MAX_MESSAGE_SEARCH_SCAN_ROWS = 50_000')
    expect(source).toContain('FROM messages ORDER BY rowid DESC LIMIT ?) m')
    expect(source).not.toContain('FROM messages ORDER BY sent_time DESC, position DESC LIMIT ?) m')
    expect(source).toContain("LIKE ? ESCAPE '\\\\'")
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
      before: 3,
      nextBefore: 1,
      total: 3,
      hasMore: true,
    })
  })

  it('returns exact sparse SQL positions alongside each reverse-page message', () => {
    const storage = seededReaderStorage()
    storage.commit({
      baseRevision: 1,
      action: 'make-positions-sparse',
      statements: [{ sql: 'UPDATE messages SET position = ? WHERE chat_id = ? AND id = ?', bind: [9, 'chat-1', 'message-3'] }],
    })

    expect(storage.loadChatMessages('chat-1', undefined, 2)).toMatchObject({
      messages: [{ chatId: 'message-2' }, { chatId: 'message-3' }],
      positions: [1, 9],
      nextPosition: 10,
      hasMore: true,
    })
    expect(storage.loadChatMessages('chat-1', 9, 2)).toMatchObject({
      messages: [{ chatId: 'message-1' }, { chatId: 'message-2' }],
      positions: [0, 1],
      nextPosition: 10,
      hasMore: false,
    })
  })

  it('rejects a page that would split tied message positions', () => {
    const storage = seededReaderStorage()
    storage.commit({
      baseRevision: 1,
      action: 'tie-positions',
      statements: [{ sql: 'UPDATE messages SET position = ? WHERE chat_id = ? AND id IN (?, ?)', bind: [9, 'chat-1', 'message-2', 'message-3'] }],
    })

    expect(() => storage.loadChatMessages('chat-1', undefined, 1)).toThrow(/tied.*position/i)
  })

  it('echoes the effective cursor while paging older messages in ascending order', () => {
    const storage = seededReaderStorage()

    expect(storage.loadChatMessages('chat-1', 2, 40)).toMatchObject({
      before: 2,
      messages: [{ chatId: 'message-1' }, { chatId: 'message-2' }],
      nextBefore: 0,
      hasMore: false,
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
      // An ordinary commit reports the two facts a chunked migration made
      // separable: the database IS now initialized, and nothing is still on its
      // way to it. See sql-migration-chunks.test.ts.
    })).toEqual({ revision: 1, initialized: true, migration: null })
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
      { sql: 'INSERT INTO system_settings (key, domain, value_type) VALUES (?, ?, ?)', bind: ['moduleSetting', 'module', 'object'] },
      { sql: 'INSERT INTO setting_extension_nodes (setting_key, node_id, parent_node_id, node_order, object_key, value_type) VALUES (?, ?, ?, ?, ?, ?)', bind: ['moduleSetting', 0, null, 0, null, 'object'] },
      { sql: 'INSERT INTO setting_extension_nodes (setting_key, node_id, parent_node_id, node_order, object_key, value_type, boolean_value) VALUES (?, ?, ?, ?, ?, ?, ?)', bind: ['moduleSetting', 1, 0, 0, 'enabled', 'boolean', 1] },
      { sql: 'INSERT INTO bot_presets (preset_id, position, name, image, api_type, ai_model, data, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', bind: ['preset-2', 1, 'Second', '', '', '', JSON.stringify({ id: 'incorrect-id', name: 'Second' }), 'hash-2'] },
      { sql: 'INSERT INTO bot_presets (preset_id, position, name, image, api_type, ai_model, data, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', bind: ['preset-1', 0, 'First', '', '', '', JSON.stringify({ name: 'First' }), 'hash-1'] },
      { sql: 'INSERT INTO plugin_custom_storage (key, value) VALUES (?, ?)', bind: ['pagefold.config.v1', JSON.stringify({ provider: 'google' })] },
      { sql: 'INSERT INTO plugin_custom_storage (key, value) VALUES (?, ?)', bind: ['__proto__', JSON.stringify({ safelyStored: true })] },
      { sql: 'INSERT INTO characters (id, position, kind, name) VALUES (?, ?, ?, ?)', bind: ['character-1', 0, 'character', 'Alice'] },
      { sql: 'INSERT INTO characters (id, position, kind, name) VALUES (?, ?, ?, ?)', bind: ['character-literal', 1, 'character', 'Literal_%'] },
      node('character_extension_nodes', 'character_id', 'character-1', {}),
      { sql: 'INSERT INTO character_extension_nodes (character_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?)', bind: ['character-1', 1, 0, 0, 'greeting', 'string', 'Hello'] },
      { sql: 'INSERT INTO chats (id, character_id, position, name, note) VALUES (?, ?, ?, ?, ?)', bind: ['chat-1', 'character-1', 0, 'Chat', 'summary'] },
      { sql: 'INSERT INTO character_tags (character_id, position, tag) VALUES (?, ?, ?)', bind: ['character-1', 0, 'fantasy'] },
      { sql: 'INSERT INTO character_tags (character_id, position, tag) VALUES (?, ?, ?)', bind: ['character-1', 1, 'tag_%'] },
      { sql: 'INSERT INTO chat_drafts (draft_key, message_text, translate_text) VALUES (?, ?, ?)', bind: ['character-1/chat-1', 'draft', '번역'] },
      ...Array.from({ length: 101 }, (_, index) => ({ sql: 'INSERT INTO chat_drafts (draft_key, message_text, translate_text) VALUES (?, ?, ?)', bind: [`draft-${String(index).padStart(3, '0')}`, '', ''] })),
      { sql: 'INSERT INTO cold_archives (archive_id, archive_kind) VALUES (?, ?)', bind: ['archive-1', 'chat'] },
      ...Array.from({ length: 101 }, (_, index) => ({ sql: 'INSERT INTO cold_archives (archive_id, archive_kind) VALUES (?, ?)', bind: [`archive-${String(index).padStart(3, '0')}`, 'chat'] })),
      { sql: 'INSERT INTO cold_extension_nodes (archive_id, node_id, parent_node_id, node_order, object_key, value_type) VALUES (?, ?, ?, ?, ?, ?)', bind: ['archive-1', 0, null, 0, null, 'object'] },
      { sql: 'INSERT INTO cold_extension_nodes (archive_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?)', bind: ['archive-1', 1, 0, 0, 'archived', 'array', null] },
      { sql: 'INSERT INTO cold_extension_nodes (archive_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?)', bind: ['archive-1', 2, 1, 0, null, 'string', 'message-1'] },
      node('chat_extension_nodes', 'chat_id', 'chat-1', {}),
      { sql: 'INSERT INTO chat_extension_nodes (chat_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?)', bind: ['chat-1', 1, 0, 0, 'custom', 'string', 'chat detail'] },
      ...[1, 2, 3].flatMap((position) => [
        { sql: 'INSERT INTO messages (chat_id, id, position, role, sent_time, content_text) VALUES (?, ?, ?, ?, ?, ?)', bind: ['chat-1', `message-${position}`, position - 1, 'user', position, position === 1 ? 'message 1 100%_\\' : `message ${position}`] },
        { sql: 'INSERT INTO message_extension_nodes (chat_id, message_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', bind: ['chat-1', `message-${position}`, 0, null, 0, null, 'object', null] },
        { sql: 'INSERT INTO message_extension_nodes (chat_id, message_id, node_id, parent_node_id, node_order, object_key, value_type, text_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', bind: ['chat-1', `message-${position}`, 1, 0, 0, 'content', 'string', `message ${position}`] },
      ]),
    ],
  })
  readerStorages.push(storage)
  return storage
}
