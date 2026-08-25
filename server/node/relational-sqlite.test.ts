import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { createRelationalSqlite, statementTable } = require('./relational-sqlite.cjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('server relational SQLite', () => {
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
