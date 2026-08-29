import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { createRelationalSqlite } = require('./relational-sqlite.cjs')

/**
 * A legacy-to-SQL migration that does not fit in one request.
 *
 * A standalone user with a 50 MB `database.bin` builds ~350,000 statements
 * against a 250,000 per-commit cap. As a single commit that migration could
 * never land -- `commit()` refused it on its first line, the client fell back to
 * the legacy database, and nothing said so. Measured in the field: 50 MB down,
 * 54 MB up, 4.1 minutes, every launch, for months.
 *
 * The cap stays: it bounds how much one request holds in memory. What changes is
 * that a migration is a SEQUENCE of commits, and these tests hold the line that
 * makes a sequence safe -- a half-applied one is never readable as a finished
 * one, and it is never readable as an empty one either.
 */

type Statement = { sql: string, bind: unknown[] }
type MigrationState = {
    id: string
    chunksApplied: number
    nextChunk: number
    statementsApplied: number
    totalChunks: number | null
    baseRevision: number
    replacedCompleteDatabase: boolean
    archivedPath: string | null
} | null
type Storage = {
    databasePath: string
    revision(): number
    dump(): { status: string, revision: number, migration: MigrationState, tables: Record<string, unknown[]> }
    bootstrap(options?: unknown): { status: string, revision: number, migration: MigrationState }
    commit(payload: unknown): { revision: number, initialized: boolean, migration: MigrationState }
    migrationState(): MigrationState
    maxStatementsPerCommit: number
    checkpoint(): unknown
    close(): void
}

const roots: string[] = []
const open: Storage[] = []
afterEach(() => {
    for (const storage of open.splice(0)) { try { storage.close() } catch { /* already closed by the test */ } }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'risu-sql-migration-'))
    roots.push(root)
    return root
}

function openStorage(dataRoot: string): Storage {
    const storage = createRelationalSqlite({ dataRoot }) as Storage
    open.push(storage)
    return storage
}

/**
 * The cap read from the server's real behaviour rather than copied here.
 *
 * `commit()` checks `statements.length` before it opens the transaction and
 * before it compares revisions, so a probe carrying an impossible
 * `baseRevision` costs nothing and separates the outcomes cleanly: at or below
 * the cap it fails with 'SQL revision conflict', above it with 'SQL commit is
 * too large'. Nothing is executed and nothing is written.
 */
function measureMaxStatementsPerCommit(storage: Storage): number {
    const filler = { sql: 'DELETE FROM messages', bind: [] }
    const tooLarge = (count: number): boolean => {
        try {
            storage.commit({ baseRevision: -1, action: 'cap-probe', statements: new Array(count).fill(filler) })
        } catch (error) {
            const message = (error as Error).message
            if (message === 'SQL commit is too large') return true
            if (message === 'SQL revision conflict') return false
            throw error
        }
        throw new Error(`the cap probe committed ${count} statements; baseRevision -1 no longer conflicts`)
    }
    const SEARCH_LIMIT = 8_000_000
    let rejected = 1
    while (!tooLarge(rejected)) {
        rejected *= 2
        if (rejected > SEARCH_LIMIT) throw new Error(`commit() accepted ${SEARCH_LIMIT} statements: no cap found`)
    }
    let accepted = rejected === 1 ? 0 : rejected / 2
    while (rejected - accepted > 1) {
        const middle = Math.floor((accepted + rejected) / 2)
        if (tooLarge(middle)) rejected = middle
        else accepted = middle
    }
    return accepted
}

/** Cheap, real, bounded statements: one plugin-storage row each. */
function pluginRows(from: number, count: number): Statement[] {
    const statements: Statement[] = []
    for (let index = from; index < from + count; index += 1) {
        statements.push({
            sql: 'INSERT INTO plugin_custom_storage (key, value) VALUES (?, ?)',
            bind: [`k${index}`, `{"i":${index}}`],
        })
    }
    return statements
}

function countRows(databasePath: string, table: string): number {
    const inspector = new DatabaseSync(databasePath)
    try {
        return Number((inspector.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as any).total)
    } finally {
        inspector.close()
    }
}

function readMeta(databasePath: string): { initialized: number, revision: number } {
    const inspector = new DatabaseSync(databasePath)
    try {
        const row = inspector
            .prepare('SELECT initialized, revision FROM system_storage_meta WHERE singleton = 1')
            .get() as { initialized: number, revision: number }
        return { initialized: Number(row.initialized), revision: Number(row.revision) }
    } finally {
        inspector.close()
    }
}

describe('chunked SQL migration', () => {
    it('enforces exactly the per-commit cap it reports', () => {
        const storage = openStorage(makeRoot())
        expect(measureMaxStatementsPerCommit(storage)).toBe(storage.maxStatementsPerCommit)
    })

    it('still refuses a single commit larger than the cap, migration or not', () => {
        const storage = openStorage(makeRoot())
        const oversized = new Array(measureMaxStatementsPerCommit(storage) + 1).fill(
            { sql: 'DELETE FROM messages', bind: [] },
        )
        // The cap bounds per-request memory. A migration chunk is still one
        // request, so flagging a commit as a migration must not buy it a pass.
        expect(() => storage.commit({
            baseRevision: 0, action: 'migrate', statements: oversized,
            migration: { id: 'm', chunk: 0, final: false },
        })).toThrow('SQL commit is too large')
        expect(() => storage.commit({ baseRevision: 0, action: 'sync', statements: oversized }))
            .toThrow('SQL commit is too large')
        // ...and refusing it wrote nothing.
        expect(storage.revision()).toBe(0)
        expect(storage.migrationState()).toBeNull()
    })

    it('carries a statement stream far larger than the cap across chunks and ends initialized', () => {
        const root = makeRoot()
        const storage = openStorage(root)
        // Measured, not imported: this test follows the cap wherever it moves.
        const cap = measureMaxStatementsPerCommit(storage)
        // Three chunks, sized from the measured cap, totalling ~1.4x the cap:
        // a stream that a single commit can never carry.
        const chunkSize = Math.floor(cap * 0.6)
        const chunks = [chunkSize, chunkSize, Math.floor(cap * 0.24)]
        const total = chunks.reduce((sum, size) => sum + size, 0)
        expect(total).toBeGreaterThan(cap)

        let revision = storage.revision()
        let written = 0
        chunks.forEach((size, index) => {
            const final = index === chunks.length - 1
            const result = storage.commit({
                baseRevision: revision,
                action: 'legacy-migration',
                statements: pluginRows(written, size),
                migration: { id: 'migration-a', chunk: index, final, totalChunks: chunks.length },
            })
            written += size
            expect(result.revision).toBe(revision + 1)
            revision = result.revision

            if (!final) {
                // Mid-flight: the rows are there, but the database is NOT
                // initialized and says so, and the session names the next chunk.
                expect(readMeta(storage.databasePath).initialized).toBe(0)
                expect(result.initialized).toBe(false)
                expect(result.migration).toMatchObject({
                    id: 'migration-a',
                    chunksApplied: index + 1,
                    nextChunk: index + 1,
                    statementsApplied: written,
                    totalChunks: chunks.length,
                })
                expect(storage.bootstrap().status).toBe('empty')
            } else {
                expect(result.initialized).toBe(true)
                expect(result.migration).toBeNull()
            }
        })

        // Verified on disk through an independent connection, not through the
        // storage object's own view.
        storage.checkpoint()
        expect(readMeta(storage.databasePath)).toEqual({ initialized: 1, revision })
        expect(countRows(storage.databasePath, 'plugin_custom_storage')).toBe(total)
        expect(storage.migrationState()).toBeNull()
        expect(storage.bootstrap()).toMatchObject({ status: 'ready', migration: null })
    }, 300_000)

    it('leaves an abandoned migration recognisable as incomplete, not as empty and not as complete', () => {
        const root = makeRoot()
        const first = openStorage(root)
        const before = first.revision()
        first.commit({
            baseRevision: before,
            action: 'legacy-migration',
            statements: pluginRows(0, 50),
            migration: { id: 'migration-b', chunk: 0, final: false, totalChunks: 2 },
        })
        // The tab closes, the network drops, the process dies. Nothing else runs.
        first.close()

        const next = openStorage(root)
        const bootstrap = next.bootstrap()
        // Not complete: `status` is still 'empty', so the client keeps its
        // legacy source and this half-database is never read as canonical.
        expect(bootstrap.status).toBe('empty')
        // Not empty either, and the difference is stated rather than implied.
        expect(bootstrap.migration).toMatchObject({
            id: 'migration-b',
            chunksApplied: 1,
            nextChunk: 1,
            statementsApplied: 50,
            totalChunks: 2,
            baseRevision: before,
            replacedCompleteDatabase: false,
        })
        expect(countRows(next.databasePath, 'plugin_custom_storage')).toBe(50)

        // ...and the migration resumes from where it stopped rather than
        // restarting, because the chunks already applied survived the crash.
        // It resumes at the length it opened with: a sequence cannot shrink
        // its declared total, or a short database could be closed as complete.
        // Re-planning means a new migration, which starts at chunk 0.
        const resumed = next.commit({
            baseRevision: next.revision(),
            action: 'legacy-migration',
            statements: pluginRows(50, 50),
            migration: { id: 'migration-b', chunk: 1, final: true, totalChunks: 2 },
        })
        expect(resumed.initialized).toBe(true)
        expect(next.bootstrap()).toMatchObject({ status: 'ready', migration: null })
        expect(countRows(next.databasePath, 'plugin_custom_storage')).toBe(100)
    })

    it('rolls a failing chunk back whole and leaves the chunks before it applied', () => {
        const storage = openStorage(makeRoot())
        storage.commit({
            baseRevision: storage.revision(),
            action: 'legacy-migration',
            statements: pluginRows(0, 40),
            migration: { id: 'migration-c', chunk: 0, final: false },
        })
        const revisionAfterFirstChunk = storage.revision()

        // A chunk whose 21st statement is rejected: the 20 before it must not
        // survive, and neither the session nor the revision may move.
        const poisoned = [
            ...pluginRows(40, 20),
            { sql: 'UPDATE system_storage_meta SET initialized = 1', bind: [] },
            ...pluginRows(60, 20),
        ]
        expect(() => storage.commit({
            baseRevision: revisionAfterFirstChunk,
            action: 'legacy-migration',
            statements: poisoned,
            migration: { id: 'migration-c', chunk: 1, final: true },
        })).toThrow('Statement targets a non-writable table')

        expect(storage.revision()).toBe(revisionAfterFirstChunk)
        expect(countRows(storage.databasePath, 'plugin_custom_storage')).toBe(40)
        expect(readMeta(storage.databasePath).initialized).toBe(0)
        expect(storage.migrationState()).toMatchObject({ id: 'migration-c', nextChunk: 1 })

        // The client retries that one chunk -- not the migration.
        const retried = storage.commit({
            baseRevision: revisionAfterFirstChunk,
            action: 'legacy-migration',
            statements: pluginRows(40, 40),
            migration: { id: 'migration-c', chunk: 1, final: true },
        })
        expect(retried.initialized).toBe(true)
        expect(countRows(storage.databasePath, 'plugin_custom_storage')).toBe(80)
    })

    it('names the chunk it expects when a chunk arrives out of order', () => {
        const storage = openStorage(makeRoot())
        storage.commit({
            baseRevision: storage.revision(),
            action: 'legacy-migration',
            statements: pluginRows(0, 10),
            migration: { id: 'migration-d', chunk: 0, final: false },
        })
        let thrown: any = null
        try {
            storage.commit({
                baseRevision: storage.revision(),
                action: 'legacy-migration',
                statements: pluginRows(30, 10),
                migration: { id: 'migration-d', chunk: 3, final: false },
            })
        } catch (error) { thrown = error }
        expect(thrown?.code).toBe('SQL_MIGRATION_SEQUENCE')
        expect(thrown?.status).toBe(409)
        expect(thrown?.expectedChunk).toBe(1)
        expect(thrown?.migration).toMatchObject({ id: 'migration-d', nextChunk: 1 })
        expect(countRows(storage.databasePath, 'plugin_custom_storage')).toBe(10)
    })

    it('refuses a chunk of a migration nobody started, and a chunk of somebody else s', () => {
        const storage = openStorage(makeRoot())
        let thrown: any = null
        try {
            storage.commit({
                baseRevision: 0, action: 'legacy-migration', statements: pluginRows(0, 5),
                migration: { id: 'migration-e', chunk: 1, final: true },
            })
        } catch (error) { thrown = error }
        expect(thrown?.code).toBe('SQL_MIGRATION_NOT_FOUND')
        expect(thrown?.migration).toBeNull()
        expect(readMeta(storage.databasePath).initialized).toBe(0)

        storage.commit({
            baseRevision: 0, action: 'legacy-migration', statements: pluginRows(0, 5),
            migration: { id: 'migration-e', chunk: 0, final: false },
        })
        thrown = null
        try {
            storage.commit({
                baseRevision: storage.revision(), action: 'legacy-migration', statements: pluginRows(5, 5),
                migration: { id: 'a-different-migration', chunk: 1, final: true },
            })
        } catch (error) { thrown = error }
        expect(thrown?.code).toBe('SQL_MIGRATION_MISMATCH')
        expect(thrown?.migration).toMatchObject({ id: 'migration-e' })
    })

    it('refuses an ordinary commit while a migration is in flight', () => {
        const storage = openStorage(makeRoot())
        storage.commit({
            baseRevision: 0, action: 'legacy-migration', statements: pluginRows(0, 5),
            migration: { id: 'migration-f', chunk: 0, final: false },
        })
        let thrown: any = null
        try {
            // An ordinary commit sets `initialized = 1`. Applying one here would
            // stamp a half-applied migration as a finished database, which is
            // the single state this whole mechanism exists to make impossible.
            storage.commit({ baseRevision: storage.revision(), action: 'sync', statements: pluginRows(99, 1) })
        } catch (error) { thrown = error }
        expect(thrown?.code).toBe('SQL_MIGRATION_IN_PROGRESS')
        expect(thrown?.status).toBe(409)
        expect(thrown?.migration).toMatchObject({ id: 'migration-f', nextChunk: 1 })
        expect(readMeta(storage.databasePath).initialized).toBe(0)
        expect(countRows(storage.databasePath, 'plugin_custom_storage')).toBe(5)
    })

    it('lets a fresh first chunk supersede an abandoned migration', () => {
        const storage = openStorage(makeRoot())
        storage.commit({
            baseRevision: 0, action: 'legacy-migration', statements: pluginRows(0, 5),
            migration: { id: 'migration-g', chunk: 0, final: false },
        })
        const restarted = storage.commit({
            baseRevision: storage.revision(),
            action: 'legacy-migration',
            // Chunk 0 of a replace-all carries the DELETEs that clear whatever
            // the abandoned attempt left behind.
            statements: [{ sql: 'DELETE FROM plugin_custom_storage', bind: [] }, ...pluginRows(0, 3)],
            migration: { id: 'migration-h', chunk: 0, final: true },
        })
        expect(restarted.initialized).toBe(true)
        expect(restarted.migration).toBeNull()
        expect(countRows(storage.databasePath, 'plugin_custom_storage')).toBe(3)
    })

    it('archives a complete database before a chunked migration starts overwriting it', () => {
        const root = makeRoot()
        const storage = openStorage(root)
        storage.commit({ baseRevision: 0, action: 'sync', statements: pluginRows(0, 7) })
        expect(readMeta(storage.databasePath).initialized).toBe(1)

        const started = storage.commit({
            baseRevision: storage.revision(),
            action: 'legacy-migration',
            statements: [{ sql: 'DELETE FROM plugin_custom_storage', bind: [] }, ...pluginRows(100, 2)],
            migration: { id: 'migration-i', chunk: 0, final: false, totalChunks: 2 },
        })
        // A chunked replace-all is not atomic the way one commit was. What it is
        // about to destroy is a database that was complete, so a consistent copy
        // of it exists before the first chunk lands -- and the session says so
        // rather than leaving the operator to find the file.
        expect(started.migration?.replacedCompleteDatabase).toBe(true)
        const archivedPath = started.migration?.archivedPath
        expect(typeof archivedPath).toBe('string')
        expect(existsSync(archivedPath as string)).toBe(true)
        expect(readMeta(archivedPath as string).initialized).toBe(1)
        expect(countRows(archivedPath as string, 'plugin_custom_storage')).toBe(7)

        // The live database meanwhile is mid-migration and says so.
        expect(readMeta(storage.databasePath).initialized).toBe(0)
        expect(countRows(storage.databasePath, 'plugin_custom_storage')).toBe(2)
    })

    it('rejects a malformed migration descriptor instead of applying the chunk as a whole database', () => {
        const storage = openStorage(makeRoot())
        const cases: unknown[] = [
            { chunk: 0, final: false },
            { id: '', chunk: 0, final: false },
            { id: 'x'.repeat(129), chunk: 0, final: false },
            { id: 'm', chunk: -1, final: false },
            { id: 'm', chunk: 1.5, final: false },
            { id: 'm', chunk: '0', final: false },
            { id: 'm', chunk: 0 },
            { id: 'm', chunk: 0, final: 'yes' },
            { id: 'm', chunk: 0, final: false, totalChunks: 0 },
            { id: 'm', chunk: 3, final: false, totalChunks: 2 },
            { id: 'm', chunk: 0, final: false, totalChunks: 1 },
            { id: 'm', chunk: 0, final: true, totalChunks: 2 },
            'migration',
            [],
        ]
        for (const migration of cases) {
            let thrown: any = null
            try {
                storage.commit({ baseRevision: 0, action: 'legacy-migration', statements: pluginRows(0, 1), migration })
            } catch (error) { thrown = error }
            expect(thrown?.code, JSON.stringify(migration)).toBe('SQL_MIGRATION_INVALID')
            expect(thrown?.status).toBe(400)
        }
        // Not one of them wrote a row or moved the revision.
        expect(storage.revision()).toBe(0)
        expect(countRows(storage.databasePath, 'plugin_custom_storage')).toBe(0)
    })

    it('leaves an ordinary commit exactly as it was', () => {
        const storage = openStorage(makeRoot())
        const result = storage.commit({ baseRevision: 0, action: 'sync', statements: pluginRows(0, 3) })
        expect(result.revision).toBe(1)
        expect(result.initialized).toBe(true)
        expect(result.migration).toBeNull()
        expect(readMeta(storage.databasePath)).toEqual({ initialized: 1, revision: 1 })
        expect(storage.bootstrap()).toMatchObject({ status: 'ready', migration: null })
    })
})
