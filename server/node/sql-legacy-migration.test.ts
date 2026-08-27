import { afterEach, expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createRelationalSqlite } = require('./relational-sqlite.cjs')
const { createSqlLegacyMigration, nodeRows, settingDomain } = require('./sql-legacy-migration.cjs')

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

test('migrates the server-owned legacy source once and remains ready after reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'risu-sql-legacy-migration-'))
  roots.push(root)
  const source = {
    username: 'legacy',
    botPresets: [],
    characters: [{ chaId: 'character-1', name: 'Alice', chats: [{ id: 'chat-1', message: [{ chatId: 'message-1', data: 'hello' }] }] }],
  }
  const readLegacy = vi.fn(async () => source)
  const first = createRelationalSqlite({ dataRoot: root })
  const migration = createSqlLegacyMigration({ relationalSql: first, readLegacy })

  const committed = await migration.migrate()
  expect(committed).toMatchObject({ status: 'ready', revision: 1 })
  expect(readLegacy).toHaveBeenCalledOnce()
  first.close()

  const reopened = createRelationalSqlite({ dataRoot: root })
  const secondRead = vi.fn(async () => { throw new Error('legacy source must not be read after migration') })
  const repeated = await createSqlLegacyMigration({ relationalSql: reopened, readLegacy: secondRead }).migrate()
  expect(repeated).toEqual(committed)
  expect(secondRead).not.toHaveBeenCalled()
  expect(reopened.bootstrap()).toMatchObject({ status: 'ready', revision: 1 })
  reopened.close()
})

test('reclaims an interrupted migration after reopening the database', async () => {
  const root = mkdtempSync(join(tmpdir(), 'risu-sql-legacy-reclaim-'))
  roots.push(root)
  const first = createRelationalSqlite({ dataRoot: root })
  first.setMigrationState('migrating')
  first.close()

  const reopened = createRelationalSqlite({ dataRoot: root })
  const result = await createSqlLegacyMigration({
    relationalSql: reopened,
    readLegacy: async () => ({ characters: [], botPresets: [] }),
  }).migrate()
  expect(result).toMatchObject({ status: 'ready', revision: 1 })
  reopened.close()
})

test('preserves canonical legacy fields, ids, tags, presets and UTF-16 strings', async () => {
  const root = mkdtempSync(join(tmpdir(), 'risu-sql-legacy-fidelity-'))
  roots.push(root)
  const storage = createRelationalSqlite({ dataRoot: root })
  const source = {
    activeBotPresetId: 'preset-1',
    pluginCustomStorage: { plugin: { value: 'kept' } },
    botPresets: [
      { id: 'preset-1', name: 'Preset', apiType: 'openai', aiModel: 'gpt', surrogate: '\ud800' },
      { id: 'preset-2', name: 'Second' },
    ],
    botPresetsId: 1,
    characters: [{ chaId: 'character-1', name: 'Alice', tags: ['alpha', 'beta'], greeting: '\ud800', ['nul\0key']: 'nul\0value', chats: [{
      id: 'chat-1', name: 'Chat', message: [{ chatId: 'message-1', role: 'user', data: '\ud800', name: 'Me', time: 5, generationInfo: { model: 'model', inputTokens: 2, outputTokens: 3 } }],
    }] }],
  }

  await createSqlLegacyMigration({ relationalSql: storage, readLegacy: async () => source }).migrate()
  expect(storage.bootstrap()).toMatchObject({
    settings: { activeBotPresetId: 'preset-2' },
    characters: [expect.objectContaining({ chaId: 'character-1' })],
  })
  expect(storage.deferredBootstrap()).toMatchObject({
    pluginCustomStorage: source.pluginCustomStorage,
    botPresets: [expect.objectContaining({ id: 'preset-1', surrogate: '\ud800' }), expect.objectContaining({ id: 'preset-2' })],
  })
  expect(storage.loadCharacter('character-1')?.character).toMatchObject({ greeting: '\ud800', ['nul\0key']: 'nul\0value' })
  expect(storage.searchCharactersByTag('beta', 10)).toEqual([expect.objectContaining({ id: 'character-1' })])
  expect(storage.loadChatMessages('chat-1', undefined, 10).messages).toEqual([expect.objectContaining({ chatId: 'message-1', data: '\ud800' })])
  storage.close()
})

test('encodes NUL and unpaired-surrogate nodes but keeps valid emoji as plain UTF-8 text', () => {
  const rows = nodeRows({ ['nul\0key']: 'nul\0value' })
  expect(rows[1]).toMatchObject({ object_key: null, object_key_encoded: expect.any(String), value_type: 'string', text_value: null, encoded_text_value: expect.any(String) })
  expect(nodeRows({ broken: '\ud800' })[1]).toMatchObject({ text_value: null, encoded_text_value: expect.any(String) })
  expect(nodeRows({ emoji: '😀' })[1]).toMatchObject({ object_key: 'emoji', object_key_encoded: null, text_value: '😀', encoded_text_value: null })
})

test('uses the shared commit setting-domain categories', () => {
  expect(settingDomain('activeBotPresetId')).toBe('model')
  expect(settingDomain('openAIKey')).toBe('provider')
  expect(settingDomain('mainPrompt')).toBe('prompt')
  expect(settingDomain('supaMemoryKey')).toBe('memory')
  expect(settingDomain('sdProvider')).toBe('media')
  expect(settingDomain('hotkeys')).toBe('ui')
  expect(settingDomain('translatorPresets')).toBe('collection')
  expect(settingDomain('other')).toBe('account-sync-compatibility')
})

test('rejects cyclic, too-deep, and oversized values before migration statements are committed', () => {
  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  expect(() => nodeRows(cyclic)).toThrow(/cycle/i)
  let deep: unknown = 'end'
  for (let index = 0; index < 129; index++) deep = { child: deep }
  expect(() => nodeRows(deep)).toThrow(/depth/i)
  expect(() => nodeRows(Array.from({ length: 250_000 }, () => null))).toThrow(/row/i)
})
