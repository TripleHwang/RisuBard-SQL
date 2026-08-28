import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const sqlite = require('node:sqlite')
const { createRelationalSqlite } = require('./relational-sqlite.cjs')
const {
  createSqlBootstrapHandler,
  createSqlRootKeyHandler,
} = require('./sql-root-key-route.cjs')
const { normalizeSqlBootstrapQuery } = require('./sql-read-route-params.cjs')

type Storage = {
  bootstrap(options?: { deferRootKeys?: Iterable<string> }): Record<string, unknown>
  loadRootKey(key: string): { revision: number; key: string; present: boolean; value?: unknown }
  commit(payload: unknown): { revision: number }
  close(): void
}

const roots: string[] = []
const storages: { close(): void }[] = []
const servers: http.Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const storage of storages.splice(0)) storage.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function newStorage(): Storage {
  const root = mkdtempSync(join(tmpdir(), 'risu-deferred-root-'))
  roots.push(root)
  const storage = createRelationalSqlite({ dataRoot: root }) as Storage
  storages.push(storage)
  return storage
}

const settingRow = (key: string, valueType: string) => ({
  sql: 'INSERT INTO system_settings (key, domain, value_type) VALUES (?, ?, ?)',
  bind: [key, 'database', valueType],
})
const settingNode = (
  key: string,
  nodeId: number,
  parent: number | null,
  order: number,
  objectKey: string | null,
  valueType: string,
  text: string | null = null,
) => ({
  sql: `INSERT INTO setting_extension_nodes
        (setting_key, node_id, parent_node_id, node_order, object_key, value_type, text_value)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
  bind: [key, nodeId, parent, order, objectKey, valueType, text],
})

/**
 * A realistic store: a handful of settings roots, plugin custom storage, bot
 * presets and one character with one chat.
 */
function seededStorage(): Storage {
  const storage = newStorage()
  storage.commit({
    baseRevision: 0,
    action: 'seed-deferred',
    statements: [
      settingRow('theme', 'string'),
      settingNode('theme', 0, null, 0, null, 'string', 'dark'),
      // `plugins` is the root the original incident deleted.
      settingRow('plugins', 'array'),
      settingNode('plugins', 0, null, 0, null, 'array'),
      settingNode('plugins', 1, 0, 0, null, 'string', 'translator-plugin'),
      settingNode('plugins', 2, 0, 1, null, 'string', 'memory-plugin'),
      // An existing root whose stored value is null — never the same as absent.
      settingRow('lastBackupAt', 'null'),
      settingNode('lastBackupAt', 0, null, 0, null, 'null'),
      {
        sql: 'INSERT INTO plugin_custom_storage (key, value) VALUES (?, ?)',
        bind: ['pagefold.config.v1', JSON.stringify({ provider: 'google' })],
      },
      {
        sql: 'INSERT INTO bot_presets (preset_id, position, name, image, api_type, ai_model, data, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        bind: ['preset-1', 0, 'First', '', '', '', JSON.stringify({ name: 'First' }), 'hash-1'],
      },
      {
        sql: 'INSERT INTO characters (id, position, kind, name) VALUES (?, ?, ?, ?)',
        bind: ['character-1', 0, 'character', 'Alice'],
      },
      {
        sql: 'INSERT INTO chats (id, character_id, position, name, note) VALUES (?, ?, ?, ?, ?)',
        bind: ['chat-1', 'character-1', 0, 'Chat', ''],
      },
    ],
  })
  return storage
}

/**
 * Same store, but the values behind `plugins` and `botPresets` are unreadable.
 * Reading either throws, so a bootstrap that completes proves the read was
 * genuinely skipped rather than performed and discarded.
 */
function poisonedStorage(): Storage {
  const storage = newStorage()
  storage.commit({
    baseRevision: 0,
    action: 'seed-poisoned',
    statements: [
      settingRow('theme', 'string'),
      settingNode('theme', 0, null, 0, null, 'string', 'dark'),
      settingRow('plugins', 'array'),
      // A well-formed row holding an odd number of UTF-16 bytes. The schema
      // accepts it; rebuilding it throws.
      {
        sql: `INSERT INTO setting_extension_nodes
              (setting_key, node_id, parent_node_id, node_order, object_key, value_type, encoded_text_value)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bind: ['plugins', 0, null, 0, null, 'string', Buffer.from([65]).toString('base64')],
      },
      {
        sql: 'INSERT INTO bot_presets (preset_id, position, name, image, api_type, ai_model, data, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        bind: ['preset-1', 0, 'First', '', '', '', '{ not json', 'hash-1'],
      },
    ],
  })
  return storage
}

function recordPreparedSql<T>(run: () => T): { result: T; sql: string[] } {
  const sql: string[] = []
  const original = sqlite.DatabaseSync.prototype.prepare
  sqlite.DatabaseSync.prototype.prepare = function patched(this: unknown, statement: string) {
    sql.push(String(statement))
    return original.call(this, statement)
  }
  try {
    return { result: run(), sql }
  } finally {
    sqlite.DatabaseSync.prototype.prepare = original
  }
}

async function listeningApp(storage: Storage): Promise<string> {
  const app = express()
  const auth = async () => true
  app.get('/api/sql/bootstrap', createSqlBootstrapHandler({ auth, relationalSql: storage }))
  app.get('/api/sql/root-keys/:rootKey', createSqlRootKeyHandler({ auth, relationalSql: storage }))
  app.use((error: Error, _req: unknown, res: any, _next: unknown) => {
    res.status(500).json({ error: error.message })
  })
  const server = http.createServer(app)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address() as { port: number }
  return `http://127.0.0.1:${address.port}`
}

describe('bootstrap root-key deferral', () => {
  it('keeps the default response complete and reports nothing deferred', () => {
    const payload = seededStorage().bootstrap()

    expect(payload.deferredRootKeys).toEqual([])
    expect(payload.absentDeferredRootKeys).toEqual([])
    expect(payload.settings).toMatchObject({
      theme: 'dark',
      plugins: ['translator-plugin', 'memory-plugin'],
      lastBackupAt: null,
    })
    expect(payload.characters).toHaveLength(1)
    expect(payload.botPresets).toEqual([{ name: 'First', id: 'preset-1' }])
  })

  it('omits a deferred setting root and reports it as deferred, not absent', () => {
    const payload = seededStorage().bootstrap({ deferRootKeys: ['plugins'] })

    expect(payload.deferredRootKeys).toEqual(['plugins'])
    expect(payload.absentDeferredRootKeys).toEqual([])
    expect(Object.keys(payload.settings as object)).not.toContain('plugins')
    expect(payload.settings).toMatchObject({ theme: 'dark' })
  })

  /**
   * The safety property this whole change exists for: a root key that is not
   * stored must never be reported as deferred, because "deferred" is what stops
   * the client from ever deleting it.
   */
  it('never reports a key that is not in storage as deferred', () => {
    const payload = seededStorage().bootstrap({
      deferRootKeys: ['plugins', 'neverStoredKey'],
    })

    expect(payload.deferredRootKeys).toEqual(['plugins'])
    expect(payload.absentDeferredRootKeys).toEqual(['neverStoredKey'])
    expect(Object.keys(payload.settings as object)).not.toContain('neverStoredKey')
  })

  it('skips the read instead of discarding it — an unreadable deferred root does not fail bootstrap', () => {
    const storage = poisonedStorage()

    expect(() => storage.bootstrap()).toThrow()
    expect(() => storage.bootstrap({ deferRootKeys: ['plugins'] })).toThrow()

    const payload = storage.bootstrap({ deferRootKeys: ['plugins', 'botPresets'] })
    expect(payload.deferredRootKeys).toEqual(['botPresets', 'plugins'])
    expect(payload.settings).toEqual({ theme: 'dark' })
    expect(payload).not.toHaveProperty('botPresets')
  })

  it('prepares no query for a deferred collection root', () => {
    const storage = seededStorage()

    const complete = recordPreparedSql(() => storage.bootstrap())
    const deferred = recordPreparedSql(() => storage.bootstrap({
      deferRootKeys: ['characters', 'pluginCustomStorage', 'botPresets'],
    }))

    // The value reads, not the cheap `SELECT 1 ... LIMIT 1` existence probes.
    const reads = [
      'SELECT key, value FROM plugin_custom_storage',
      'SELECT preset_id, data FROM bot_presets',
      'SELECT * FROM characters ORDER BY position',
      'FROM chats c LEFT JOIN messages',
    ]
    const hits = (sql: string[], fragment: string) =>
      sql.filter((statement) => statement.replace(/\s+/g, ' ').includes(fragment)).length
    for (const fragment of reads) {
      expect(hits(complete.sql, fragment), `complete: ${fragment}`).toBeGreaterThan(0)
      expect(hits(deferred.sql, fragment), `deferred: ${fragment}`).toBe(0)
    }

    const payload = deferred.result
    expect(payload.deferredRootKeys).toEqual(['botPresets', 'characters', 'pluginCustomStorage'])
    expect(payload).not.toHaveProperty('characters')
    expect(payload).not.toHaveProperty('pluginCustomStorage')
    expect(payload).not.toHaveProperty('botPresets')
  })

  it('prepares one fewer setting-node read per deferred setting root', () => {
    const storage = seededStorage()
    const nodeQuery = 'FROM setting_extension_nodes'
    const count = (sql: string[]) => sql.filter((statement) => statement.includes(nodeQuery)).length

    const complete = recordPreparedSql(() => storage.bootstrap())
    const deferred = recordPreparedSql(() => storage.bootstrap({ deferRootKeys: ['plugins'] }))

    expect(count(complete.sql)).toBe(3)
    expect(count(deferred.sql)).toBe(2)
  })

  it('does not defer an empty collection root, because there is nothing stored to defer', () => {
    const storage = newStorage()
    storage.commit({
      baseRevision: 0,
      action: 'seed-empty',
      statements: [settingRow('theme', 'string'), settingNode('theme', 0, null, 0, null, 'string', 'dark')],
    })

    const payload = storage.bootstrap({ deferRootKeys: ['characters', 'pluginCustomStorage', 'botPresets'] })

    expect(payload.deferredRootKeys).toEqual([])
    expect(payload.absentDeferredRootKeys).toEqual(['botPresets', 'characters', 'pluginCustomStorage'])
    expect(payload.characters).toEqual([])
    expect(payload.botPresets).toEqual([])
    expect(JSON.parse(JSON.stringify(payload.pluginCustomStorage))).toEqual({})
  })

  it('reports a settings row that rebuilds to no value instead of silently dropping it', () => {
    const storage = newStorage()
    storage.commit({
      baseRevision: 0,
      action: 'seed-nodeless',
      statements: [settingRow('halfWritten', 'object')],
    })

    const payload = storage.bootstrap()

    expect(payload.unreadableRootKeys).toEqual(['halfWritten'])
    expect(payload.deferredRootKeys).toEqual([])
  })

  it('rejects unbounded or non-string deferral requests', () => {
    const storage = seededStorage()

    expect(() => storage.bootstrap({ deferRootKeys: ['x'.repeat(257)] })).toThrow(/deferred root key/i)
    expect(() => storage.bootstrap({ deferRootKeys: [42 as unknown as string] })).toThrow(/deferred root key/i)
    expect(() => storage.bootstrap({ deferRootKeys: 'plugins' as unknown as string[] })).toThrow(/deferred root key/i)
    expect(() => storage.bootstrap({
      deferRootKeys: Array.from({ length: 513 }, (_, index) => `key-${index}`),
    })).toThrow(/too many/i)
  })
})

describe('single root-key hydration', () => {
  it('returns a stored root value with its revision', () => {
    const storage = seededStorage()

    expect(storage.loadRootKey('plugins')).toEqual({
      revision: 1,
      key: 'plugins',
      present: true,
      value: ['translator-plugin', 'memory-plugin'],
    })
  })

  it('separates a stored null from a key that is not stored', () => {
    const storage = seededStorage()

    expect(storage.loadRootKey('lastBackupAt')).toEqual({
      revision: 1, key: 'lastBackupAt', present: true, value: null,
    })
    expect(storage.loadRootKey('neverStoredKey')).toEqual({
      revision: 1, key: 'neverStoredKey', present: false,
    })
  })

  it('hydrates collection roots in the same shape bootstrap would have sent', () => {
    const storage = seededStorage()
    const complete = storage.bootstrap()

    expect(storage.loadRootKey('botPresets')).toEqual({
      revision: 1, key: 'botPresets', present: true, value: complete.botPresets,
    })
    expect(storage.loadRootKey('characters')).toEqual({
      revision: 1, key: 'characters', present: true, value: complete.characters,
    })
    const plugins = storage.loadRootKey('pluginCustomStorage')
    expect(plugins.present).toBe(true)
    expect(JSON.parse(JSON.stringify(plugins.value))).toEqual({
      'pagefold.config.v1': { provider: 'google' },
    })
  })

  it('reports an empty collection root as not present rather than inventing a value', () => {
    const storage = newStorage()

    expect(storage.loadRootKey('characters')).toEqual({ revision: 0, key: 'characters', present: false })
    expect(storage.loadRootKey('botPresets')).toEqual({ revision: 0, key: 'botPresets', present: false })
  })

  it('raises a loud error for a settings row with no relational nodes', () => {
    const storage = newStorage()
    storage.commit({
      baseRevision: 0, action: 'seed-nodeless',
      statements: [settingRow('halfWritten', 'object')],
    })

    expect(() => storage.loadRootKey('halfWritten')).toThrow(/without relational nodes/i)
  })

  it('rejects unbounded keys', () => {
    const storage = seededStorage()

    expect(() => storage.loadRootKey('x'.repeat(257))).toThrow(/root key/i)
    expect(() => storage.loadRootKey('')).toThrow(/root key/i)
  })
})

describe('bootstrap defer query normalisation', () => {
  it('accepts comma lists and repeated parameters, and rejects oversized input', () => {
    expect(normalizeSqlBootstrapQuery({})).toEqual({ deferRootKeys: [] })
    expect(normalizeSqlBootstrapQuery({ defer: 'plugins, botPresets' }))
      .toEqual({ deferRootKeys: ['plugins', 'botPresets'] })
    expect(normalizeSqlBootstrapQuery({ defer: ['plugins', 'botPresets,characters'] }))
      .toEqual({ deferRootKeys: ['plugins', 'botPresets', 'characters'] })
    expect(normalizeSqlBootstrapQuery({ defer: '' })).toEqual({ deferRootKeys: [] })
    expect(normalizeSqlBootstrapQuery({ defer: { evil: '1' } }).error).toBeTruthy()
    expect(normalizeSqlBootstrapQuery({ defer: 'x'.repeat(257) }).error).toBeTruthy()
    expect(normalizeSqlBootstrapQuery({ defer: 'a,'.repeat(9000) }).error).toBeTruthy()
  })
})

describe('SQL root-key HTTP routes', () => {
  it('serves a deferred bootstrap and then the deferred key on demand', async () => {
    const storage = seededStorage()
    const origin = await listeningApp(storage)

    const bootstrapResponse = await fetch(`${origin}/api/sql/bootstrap?defer=plugins,pluginCustomStorage`)
    expect(bootstrapResponse.status).toBe(200)
    expect(bootstrapResponse.headers.get('cache-control')).toBe('no-store')
    const payload = await bootstrapResponse.json()
    expect(payload.deferredRootKeys).toEqual(['pluginCustomStorage', 'plugins'])
    expect(payload.absentDeferredRootKeys).toEqual([])
    expect(payload).not.toHaveProperty('pluginCustomStorage')
    expect(payload.settings).not.toHaveProperty('plugins')

    const keyResponse = await fetch(`${origin}/api/sql/root-keys/plugins`)
    expect(keyResponse.status).toBe(200)
    expect(keyResponse.headers.get('cache-control')).toBe('no-store')
    expect(await keyResponse.json()).toEqual({
      revision: 1, key: 'plugins', present: true, value: ['translator-plugin', 'memory-plugin'],
    })
  })

  it('answers a stored null with 200 and an unstored key with an explicit present:false', async () => {
    const origin = await listeningApp(seededStorage())

    const stored = await fetch(`${origin}/api/sql/root-keys/lastBackupAt`)
    expect(stored.status).toBe(200)
    expect(await stored.json()).toEqual({
      revision: 1, key: 'lastBackupAt', present: true, value: null,
    })

    const missing = await fetch(`${origin}/api/sql/root-keys/neverStoredKey`)
    expect(missing.status).toBe(404)
    expect(missing.headers.get('cache-control')).toBe('no-store')
    expect(await missing.json()).toEqual({
      error: 'Root key not found', key: 'neverStoredKey', present: false,
    })
  })

  it('rejects an oversized key with 400 and never reaches storage', async () => {
    const storage = seededStorage()
    let reads = 0
    const origin = await listeningApp({
      ...storage,
      loadRootKey(key: string) {
        reads += 1
        return storage.loadRootKey(key)
      },
    } as Storage)

    const response = await fetch(`${origin}/api/sql/root-keys/${'x'.repeat(300)}`)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid key' })
    expect(reads).toBe(0)
  })

  it('rejects an oversized defer list with 400', async () => {
    const origin = await listeningApp(seededStorage())

    const response = await fetch(`${origin}/api/sql/bootstrap?defer=${'x'.repeat(300)}`)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/deferred root key/i)
  })

  it('requires authentication before doing any work', async () => {
    const storage = seededStorage()
    const app = express()
    const auth = async (_req: unknown, res: any) => {
      res.status(401).json({ error: 'Unauthorized' })
      return false
    }
    app.get('/api/sql/bootstrap', createSqlBootstrapHandler({ auth, relationalSql: storage }))
    app.get('/api/sql/root-keys/:rootKey', createSqlRootKeyHandler({ auth, relationalSql: storage }))
    const server = http.createServer(app)
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    expect((await fetch(`${origin}/api/sql/bootstrap`)).status).toBe(401)
    expect((await fetch(`${origin}/api/sql/root-keys/plugins`)).status).toBe(401)
  })
})
