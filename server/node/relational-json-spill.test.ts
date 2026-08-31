/**
 * The client writer and the server reader must agree about a value stored as
 * one canonical-JSON row.
 *
 * This is the half of the fix that no client-side test can prove. The client
 * builds statements with `applySqliteCommit`; the server applies them and, on
 * every launch, rebuilds every root setting from `setting_extension_nodes` with
 * its OWN copy of the codec (`relational-sqlite.cjs`). If only one of the two
 * knows about the spill marker, a large `modules` is written successfully and
 * comes back as a meaningless JSON string -- which is worse than the throw it
 * replaced.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { applySqliteCommit } from '../../src/ts/storage/sql/sqliteCommit'
import { createEmptySqlCommit } from '../../src/ts/storage/sql/sqlCommit'
import {
  MAX_RELATIONAL_NODE_ROWS_PER_VALUE,
  measureRelationalValue,
} from '../../src/ts/storage/sql/relationalNodeCodec'

const { createRelationalSqlite } = require('./relational-sqlite.cjs')

const roots: string[] = []
const storages: { close(): void }[] = []
afterEach(() => {
  for (const storage of storages.splice(0)) storage.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function freshStorage() {
  const root = mkdtempSync(join(tmpdir(), 'risu-json-spill-'))
  roots.push(root)
  const storage = createRelationalSqlite({ dataRoot: root })
  storages.push(storage)
  return storage
}

/** A module set past the per-value row budget, shaped like the real one. */
function oversizedModules() {
  const lorebook = Array.from({ length: 6_000 }, (_unused, index) => ({
    key: `key-${index}`,
    comment: `entry ${index}`,
    content: `content ${index} 😀 한국어`,
    mode: 'normal',
    insertorder: index,
    alwaysActive: false,
  }))
  return [
    { id: 'module-one', name: 'One', lorebook },
    { id: 'module-two', name: 'Two', lorebook: lorebook.slice(0, 10) },
  ]
}

async function statementsFor(key: string, value: unknown) {
  const commit = createEmptySqlCommit(0, 'dirty-sync')
  commit.root.upserts.push({ key, value })
  const statements: { sql: string; bind: unknown[] }[] = []
  await applySqliteCommit(commit, (sql, bind = []) => { statements.push({ sql, bind }) })
  return statements
}

describe('a spilled root value across the client/server boundary', () => {
  it('is written by the client and read back by the server unchanged', async () => {
    const value = oversizedModules()
    expect(measureRelationalValue(value)).toBeGreaterThan(MAX_RELATIONAL_NODE_ROWS_PER_VALUE)

    const storage = freshStorage()
    const statements = await statementsFor('modules', value)
    // The entire value is three statements, not tens of thousands of them.
    expect(statements).toHaveLength(3)
    storage.commit({ baseRevision: 0, action: 'sync', statements })

    expect(storage.bootstrap().settings.modules).toEqual(value)
  })

  it('is served by the single-root-key route the same way', async () => {
    const value = oversizedModules()
    const storage = freshStorage()
    storage.commit({
      baseRevision: 0,
      action: 'sync',
      statements: await statementsFor('modules', value),
    })

    expect(storage.loadRootKey('modules')).toMatchObject({ key: 'modules', present: true, value })
  })

  it('leaves an ordinary value relational, so existing databases are untouched', async () => {
    const storage = freshStorage()
    const value = { enabled: true, names: ['a', 'b'], nested: { count: 2 } }
    const statements = await statementsFor('moduleSetting', value)
    expect(statements.length).toBeGreaterThan(3)
    storage.commit({ baseRevision: 0, action: 'sync', statements })

    expect(storage.bootstrap().settings.moduleSetting).toEqual(value)
  })

  it('survives a rewrite from spilled back to relational', async () => {
    const storage = freshStorage()
    storage.commit({
      baseRevision: 0,
      action: 'sync',
      statements: await statementsFor('modules', oversizedModules()),
    })
    const small = [{ id: 'module-one', name: 'One', lorebook: [] }]
    storage.commit({
      baseRevision: storage.bootstrap().revision,
      action: 'sync',
      statements: await statementsFor('modules', small),
    })

    expect(storage.bootstrap().settings.modules).toEqual(small)
  })
})

/**
 * The spill is not a settings feature. `replaceNodes` is the one path every node
 * table goes through, so the same 20,000-node bound now applies to characters,
 * chats and messages -- and a character with a large lorebook crosses it far
 * more easily than `modules` does. Roughly 2,500 lorebook entries is enough,
 * which is an ordinary large character card, not an exotic one.
 *
 * So the detail-load route has to read a spilled character back as a character,
 * not as a JSON string, on the launch after it was written.
 */
describe('a spilled character and chat', () => {
  /** A lorebook big enough to cross the per-value row budget. */
  function bigLorebook(entries: number) {
    return Array.from({ length: entries }, (_unused, index) => ({
      key: `key-${index}`,
      comment: `entry ${index}`,
      content: `content ${index}`,
      mode: 'normal',
      insertorder: index,
      alwaysActive: false,
      selective: false,
    }))
  }

  async function statementsForCommit(build: (commit: any) => void) {
    const commit = createEmptySqlCommit(0, 'dirty-sync')
    build(commit)
    const statements: { sql: string; bind: unknown[] }[] = []
    await applySqliteCommit(commit, (sql, bind = []) => { statements.push({ sql, bind }) })
    return statements
  }

  it('comes back from the character detail route as the character it was', async () => {
    const storage = freshStorage()
    const data = {
      name: 'Nia',
      desc: 'A very long description',
      globalLore: bigLorebook(4_000),
      customscript: [{ in: 'a', out: 'b', type: 'editinput' }],
    }
    expect(measureRelationalValue(data)).toBeGreaterThan(MAX_RELATIONAL_NODE_ROWS_PER_VALUE)

    storage.commit({
      baseRevision: 0,
      action: 'sync',
      statements: await statementsForCommit((commit) => {
        commit.characters.push({ id: 'char-1', position: 0, data })
      }),
    })

    const loaded = storage.loadCharacter('char-1')
    expect(loaded.character).toMatchObject({ ...data, chaId: 'char-1', detailsLoaded: true })
    // The summary columns are written from the same object and must still be
    // the character's own values, not anything derived from the spilled row.
    expect(storage.bootstrap().characters).toMatchObject([{ chaId: 'char-1', name: 'Nia' }])
  })

  it('comes back from the chat detail route as the chat it was', async () => {
    const storage = freshStorage()
    const chatData = { name: 'Long chat', localLore: bigLorebook(4_000), fmIndex: 2 }
    expect(measureRelationalValue(chatData)).toBeGreaterThan(MAX_RELATIONAL_NODE_ROWS_PER_VALUE)

    storage.commit({
      baseRevision: 0,
      action: 'sync',
      statements: await statementsForCommit((commit) => {
        commit.characters.push({ id: 'char-1', position: 0, data: { name: 'Nia' } })
        commit.chats.push({ id: 'chat-1', characterId: 'char-1', position: 0, data: chatData })
      }),
    })

    expect(storage.loadChat('chat-1').chat).toMatchObject(chatData)
  })
})
