/**
 * Do plugin enable/disable, per-plugin settings, and plugin custom storage
 * survive a reload in SQL mode?
 *
 * Every other test in this area stops at one side of the boundary: the client
 * ones assert what the dirty commit contained, the server ones assert what a
 * hand-written statement stored. Neither answers the question the user actually
 * asks, because the two holes this codebase keeps producing both live in the
 * gap between them -- a value written to SQL that no route ever reads back
 * (chat settings), and a side effect that only ran inside a function nobody
 * calls any more (`saveDb`).
 *
 * So this drives the real thing end to end: mutate the live database exactly as
 * `PluginSettings.svelte` and `pluginStorage.setItem` do, let the real audit
 * turn that into dirty marks, let the real dirty commit build real statements,
 * apply them to a real SQLite file with the server's own module, and then read
 * them back the way the next launch does -- `bootstrap()` for a resident key,
 * `loadRootKey()` for the deferred one.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { applySqliteCommit } from '../../src/ts/storage/sql/sqliteCommit'
import type { ISqlStorage } from '../../src/ts/storage/sql/ISqlStorage'
import {
  activateSqlPersistenceRuntime,
  auditSqlCompatibilityDatabase,
  flushSqlDirtyChanges,
  initializeSqlCompatibilityBaseline,
  resetSqlPersistenceRuntimeForTesting,
} from '../../src/ts/storage/sql/sqlPersistenceRuntime'
import {
  deferredRootDeleteRefusals,
  markRootKeyDeferred,
  resetDeferredRootKeys,
} from '../../src/ts/storage/sql/deferredRootKeys'

const { createRelationalSqlite } = require('./relational-sqlite.cjs')

const roots: string[] = []
const sqlites: { close(): void }[] = []

afterEach(() => {
  resetSqlPersistenceRuntimeForTesting()
  resetDeferredRootKeys()
  for (const sqlite of sqlites.splice(0)) sqlite.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function freshSqlite() {
  const root = mkdtempSync(join(tmpdir(), 'risu-plugin-persist-'))
  roots.push(root)
  const sqlite = createRelationalSqlite({ dataRoot: root })
  sqlites.push(sqlite)
  return sqlite
}

/**
 * The client's persistence runtime wired to a real database file: the commit is
 * turned into statements by the same `applySqliteCommit` the Node backend runs,
 * and applied by the same module the HTTP route calls.
 */
function liveStorage(sqlite: any): ISqlStorage & { statements: { sql: string; bind: unknown[] }[] } {
  // A launch reads the current revision from bootstrap; starting at 0 against a
  // database that has already been written is a revision conflict, not a test.
  let revision = sqlite.bootstrap().revision
  const statements: { sql: string; bind: unknown[] }[] = []
  return {
    getRevision: () => revision,
    async commit(commit: any) {
      const batch: { sql: string; bind: unknown[] }[] = []
      await applySqliteCommit(commit, (sql, bind = []) => { batch.push({ sql, bind }) })
      statements.push(...batch)
      const result = sqlite.commit({ baseRevision: revision, action: 'sync', statements: batch })
      revision = result.revision
      return { revision }
    },
    statements,
  } as unknown as ISqlStorage & { statements: { sql: string; bind: unknown[] }[] }
}

/** A live database in the shape metadata-first startup installs. */
function liveDatabase() {
  return {
    username: 'User',
    characters: [],
    botPresets: [],
    plugins: [
      { name: 'Translator', enabled: true, realArg: { endpoint: 'https://a', retries: 2 } },
      { name: 'Muted', enabled: false, realArg: {} },
    ],
    pluginCustomStorage: { 'Translator::token': 'first' },
  } as any
}

/** Everything a fresh launch would put back into memory for the plugin surface. */
function reload(sqlite: any) {
  const payload = sqlite.bootstrap()
  return {
    plugins: payload.settings.plugins,
    pluginCustomStorage: payload.pluginCustomStorage,
    deferredLoad: () => sqlite.loadRootKey('pluginCustomStorage'),
  }
}

describe('the plugin surface across a reload in SQL mode', () => {
  it('stores enable/disable, per-plugin settings and custom storage on the first write', async () => {
    const sqlite = freshSqlite()
    const database = liveDatabase()
    activateSqlPersistenceRuntime(liveStorage(sqlite), database)
    // A fresh baseline knows nothing, so the first audit writes everything --
    // this is the "these keys exist in storage at all" case.
    initializeSqlCompatibilityBaseline({ characters: [], botPresets: [] } as any)
    auditSqlCompatibilityDatabase(database)
    await flushSqlDirtyChanges()

    const after = reload(sqlite)
    expect(after.plugins).toEqual(database.plugins)
    expect(after.pluginCustomStorage).toEqual({ 'Translator::token': 'first' })
  })

  /**
   * `PluginSettings.svelte` sets `plugin.enabled` and calls
   * `requestImmediateSave()`, which in this mode is audit-then-flush. `plugins`
   * is an ordinary root key -- not deferred, not structural -- so it is stored
   * as one `system_settings` row plus its relational nodes.
   */
  it('keeps a plugin the user switched off switched off', async () => {
    const sqlite = freshSqlite()
    const database = liveDatabase()
    activateSqlPersistenceRuntime(liveStorage(sqlite), database)
    initializeSqlCompatibilityBaseline(database)

    database.plugins[0].enabled = false
    auditSqlCompatibilityDatabase(database)
    await flushSqlDirtyChanges()

    expect(reload(sqlite).plugins).toMatchObject([
      { name: 'Translator', enabled: false },
      { name: 'Muted', enabled: false },
    ])
  })

  /**
   * `realArg` is edited through `bind:value` with no `requestImmediateSave`, so
   * it reaches storage only through the audit. That it reaches storage at all is
   * what this asserts; the window before the audit runs is covered by
   * `metadataPersistenceGaps.test.ts`.
   */
  it('keeps a per-plugin setting the user typed', async () => {
    const sqlite = freshSqlite()
    const database = liveDatabase()
    activateSqlPersistenceRuntime(liveStorage(sqlite), database)
    initializeSqlCompatibilityBaseline(database)

    database.plugins[0].realArg.endpoint = 'https://b'
    database.plugins[0].realArg.retries = 7
    auditSqlCompatibilityDatabase(database)
    await flushSqlDirtyChanges()

    expect(reload(sqlite).plugins[0].realArg).toEqual({ endpoint: 'https://b', retries: 7 })
  })

  /**
   * `pluginStorage.setItem` writes straight into `db.pluginCustomStorage`, which
   * is NOT a `system_settings` row: it has its own table and its own bootstrap
   * field, and it is the one root key the client asks the server to withhold at
   * startup. So this half only works if the deferred-read route agrees with the
   * write -- the exact seam where chat settings were written and never read.
   */
  it('keeps a plugin storage write, and serves it from the deferred-load route', async () => {
    const sqlite = freshSqlite()
    const database = liveDatabase()
    activateSqlPersistenceRuntime(liveStorage(sqlite), database)
    initializeSqlCompatibilityBaseline(database)

    database.pluginCustomStorage['Translator::token'] = 'second'
    database.pluginCustomStorage['Translator::cache'] = { hits: 3, entries: ['a', 'b'] }
    auditSqlCompatibilityDatabase(database)
    await flushSqlDirtyChanges()

    const after = reload(sqlite)
    expect(after.pluginCustomStorage).toEqual({
      'Translator::token': 'second',
      'Translator::cache': { hits: 3, entries: ['a', 'b'] },
    })
    // The startup path: withheld from bootstrap, fetched on demand by
    // `ensureRootKeyHydrated` through `GET /api/sql/root-keys/:rootKey`.
    expect(after.deferredLoad()).toMatchObject({
      key: 'pluginCustomStorage',
      present: true,
      value: {
        'Translator::token': 'second',
        'Translator::cache': { hits: 3, entries: ['a', 'b'] },
      },
    })
  })

  it('forgets a plugin storage key the plugin removed', async () => {
    const sqlite = freshSqlite()
    const database = liveDatabase()
    activateSqlPersistenceRuntime(liveStorage(sqlite), database)
    initializeSqlCompatibilityBaseline(database)

    delete database.pluginCustomStorage['Translator::token']
    auditSqlCompatibilityDatabase(database)
    await flushSqlDirtyChanges()

    expect(reload(sqlite).pluginCustomStorage).toEqual({})
  })

  /**
   * The known -> unknown transition, which is the one the audit has to refuse
   * on its own.
   *
   * `pluginCustomStorage` is the single key the client asks the server to
   * withhold, so a session can hold a populated baseline for it and then stop
   * being able to see it -- an eviction, or a refetch that defers it again. A
   * diff across that boundary reads every row as removed, and a removed plugin
   * storage row is a DELETE.
   *
   * The refusal in `buildSqlDirtyCommit` is the second line and is covered by
   * `deferredPluginStorage.test.ts`; what this pins is that the audit never
   * marks the keys at all, so nothing has to be refused. `deferredRootDeleteRefusals`
   * is the difference between the two: an empty log means the first line held.
   */
  it('does not mark stored plugin storage dirty when it stops being visible', async () => {
    const sqlite = freshSqlite()
    const seeded = liveDatabase()
    activateSqlPersistenceRuntime(liveStorage(sqlite), seeded)
    initializeSqlCompatibilityBaseline({ characters: [], botPresets: [] } as any)
    auditSqlCompatibilityDatabase(seeded)
    await flushSqlDirtyChanges()

    // Same session, same populated baseline -- and now the map is gone from
    // memory while its rows are still in storage.
    delete seeded.pluginCustomStorage
    markRootKeyDeferred('pluginCustomStorage')
    const second = liveStorage(sqlite)
    activateSqlPersistenceRuntime(second, seeded)
    seeded.username = 'Renamed'
    auditSqlCompatibilityDatabase(seeded)
    await flushSqlDirtyChanges()

    expect(deferredRootDeleteRefusals()).toEqual([])
    expect(second.statements.some(
      (statement) => /plugin_custom_storage/i.test(statement.sql),
    )).toBe(false)
    // The unrelated edit in the same flush still went.
    expect(reload(sqlite).pluginCustomStorage).toEqual({ 'Translator::token': 'first' })
    expect(sqlite.bootstrap().settings.username).toBe('Renamed')
  })
})
