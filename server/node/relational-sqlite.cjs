'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const TABLES = Object.freeze([
    'system_storage_meta',
    'system_revisions',
    'system_settings',
    'setting_extension_nodes',
    'bot_presets',
    'characters',
    'character_extension_nodes',
    'character_tags',
    'chats',
    'chat_extension_nodes',
    'messages',
    'message_extension_nodes',
    'plugin_custom_storage',
    'cold_archives',
    'cold_extension_nodes',
    'chat_drafts',
]);

const WRITABLE_TABLES = new Set(TABLES.filter((table) => (
    table !== 'system_storage_meta' && table !== 'system_revisions'
)));

function statementTable(sql) {
    const normalized = String(sql || '').trim();
    if (!normalized || normalized.includes(';') || /--|\/\*/.test(normalized)) {
        throw new Error('Unsafe SQL statement');
    }
    if (/\b(?:attach|detach|pragma|drop|alter|create|vacuum|reindex)\b/i.test(normalized)) {
        throw new Error('DDL and PRAGMA statements are not accepted');
    }
    const match = normalized.match(/^(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/i);
    if (!match || !WRITABLE_TABLES.has(match[1].toLowerCase())) {
        throw new Error('Statement targets a non-writable table');
    }
    return match[1].toLowerCase();
}

function createRelationalSqlite(options) {
    const dataRoot = path.resolve(options.dataRoot);
    const sqlDirectory = path.join(dataRoot, 'sql');
    fs.mkdirSync(sqlDirectory, { recursive: true });
    const databasePath = path.resolve(
        options.databasePath || path.join(sqlDirectory, 'risu-standalone.sqlite3'),
    );
    if (!databasePath.startsWith(sqlDirectory + path.sep) && databasePath !== sqlDirectory) {
        throw new Error('Relational SQLite path must stay inside the SQL data directory');
    }
    const schemaPath = path.resolve(
        options.schemaPath || path.join(__dirname, 'relational-schema.sql'),
    );
    const schema = fs.readFileSync(schemaPath, 'utf8');
    let database;

    function openDatabase() {
        database = new DatabaseSync(databasePath);
        database.exec(schema);
    }

    openDatabase();

    function revision() {
        const row = database.prepare(
            'SELECT revision FROM system_storage_meta WHERE singleton = 1',
        ).get();
        return Number(row?.revision) || 0;
    }

    function dump() {
        const tables = {};
        for (const table of TABLES) {
            tables[table] = database.prepare(`SELECT * FROM ${table}`).all();
        }
        const meta = tables.system_storage_meta[0] || {};
        return {
            status: Number(meta.initialized) === 1 ? 'ready' : 'empty',
            revision: Number(meta.revision) || 0,
            tables,
        };
    }

    function commit(payload) {
        const statements = Array.isArray(payload?.statements) ? payload.statements : [];
        if (statements.length > 250_000) throw new Error('SQL commit is too large');
        const baseRevision = Number(payload?.baseRevision);
        database.exec('BEGIN IMMEDIATE');
        try {
            const currentRevision = revision();
            if (baseRevision !== currentRevision) {
                const error = new Error('SQL revision conflict');
                error.code = 'SQL_REVISION_CONFLICT';
                error.currentRevision = currentRevision;
                throw error;
            }
            for (const entry of statements) {
                statementTable(entry?.sql);
                const bind = Array.isArray(entry?.bind) ? entry.bind : [];
                database.prepare(entry.sql).run(...bind);
            }
            const nextRevision = currentRevision + 1;
            database.prepare(
                `UPDATE system_storage_meta
                 SET revision = ?, initialized = 1, updated_at = datetime('now')
                 WHERE singleton = 1`,
            ).run(nextRevision);
            database.prepare(
                `INSERT INTO system_revisions
                 (storage_revision, database_initialized, scope, action, created_at)
                 VALUES (?, 1, 'database', ?, datetime('now'))`,
            ).run(nextRevision, String(payload?.action || 'sync').slice(0, 128));
            database.exec('COMMIT');
            return { revision: nextRevision };
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch {}
            throw error;
        }
    }

    function checkpoint() {
        database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        return { databasePath, revision: revision() };
    }

    function close() {
        database.close();
    }

    /**
     * Compatibility imports restore database.bin. Archive the previous SQL
     * canonical store and reopen an empty one so the next browser boot performs
     * the normal, verified legacy-to-SQL migration.
     */
    function reset() {
        const previousRevision = revision();
        database.close();
        const archiveDirectory = path.join(dataRoot, 'migration-backups');
        fs.mkdirSync(archiveDirectory, { recursive: true });
        const suffix = `${Date.now()}-${process.pid}`;
        let archivedPath = null;
        if (fs.existsSync(databasePath)) {
            archivedPath = path.join(
                archiveDirectory,
                `sql-pre-compat-import-${suffix}.sqlite3`,
            );
            fs.renameSync(databasePath, archivedPath);
        }
        for (const sidecar of [`${databasePath}-wal`, `${databasePath}-shm`]) {
            if (fs.existsSync(sidecar)) {
                fs.renameSync(sidecar, `${archivedPath || databasePath}.${path.basename(sidecar)}`);
            }
        }
        openDatabase();
        return { archivedPath, previousRevision };
    }

    return { databasePath, revision, dump, commit, checkpoint, reset, close };
}

module.exports = {
    TABLES,
    createRelationalSqlite,
    statementTable,
};
