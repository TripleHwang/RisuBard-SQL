import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const { createFileKv } = require('./file-kv.cjs')
const { migrateLegacySqlite } = require('./legacy-sqlite-import.cjs')

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })))

describe('one-shot legacy SQLite import', () => {
    it('backs up the source and imports raw plus chunked values without deleting the original', () => {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-sqlite-import-'))
        roots.push(dataRoot)
        const sqlitePath = path.join(dataRoot, 'risuai.db')
        const db = new DatabaseSync(sqlitePath)
        db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, updated_at INTEGER NOT NULL)')
        db.exec('CREATE TABLE chunks (hash TEXT PRIMARY KEY, data BLOB NOT NULL)')
        db.exec('CREATE TABLE manifest_chunks (manifest_key TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL)')
        const raw = db.prepare('INSERT INTO kv VALUES (?, ?, ?)')
        raw.run('assets/raw', Buffer.from('asset'), Date.now())
        raw.run('database/database.bin', Buffer.from('\0RISUCHUNKED\0', 'binary'), Date.now())
        db.prepare('INSERT INTO chunks VALUES (?, ?)').run('a', Buffer.from('database-'))
        db.prepare('INSERT INTO chunks VALUES (?, ?)').run('b', Buffer.from('bytes'))
        db.prepare('INSERT INTO manifest_chunks VALUES (?, ?, ?)').run('database/database.bin', 0, 'a')
        db.prepare('INSERT INTO manifest_chunks VALUES (?, ?, ?)').run('database/database.bin', 1, 'b')
        db.close()

        const store = createFileKv({ dataRoot })
        const result = migrateLegacySqlite({ dataRoot, store, sqlitePath })
        expect(result).toMatchObject({ migrated: true, entries: 2 })
        expect(store.kvGet('assets/raw')?.toString()).toBe('asset')
        expect(store.kvGet('database/database.bin')?.toString()).toBe('database-bytes')
        expect(fs.existsSync(sqlitePath)).toBe(true)
        expect(fs.existsSync(result.backupPath)).toBe(true)

        expect(migrateLegacySqlite({ dataRoot, store, sqlitePath })).toMatchObject({ migrated: false, reason: 'already-migrated' })
    })
})
