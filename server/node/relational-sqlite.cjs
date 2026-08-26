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
const BOOTSTRAP_SETTING_KEYS = Object.freeze([
    'language', 'theme', 'textTheme', 'colorSchemeName', 'customColorScheme',
    'zoomsize', 'iconsize', 'heightMode', 'characterOrder', 'selectedPersona',
    'apiType', 'aiModel', 'subModel', 'temperature', 'maxContext', 'maxResponse',
    'frequencyPenalty', 'PresensePenalty', 'username', 'userIcon',
]);
const DEFAULT_MESSAGE_PAGE_LIMIT = 40;
const MAX_MESSAGE_PAGE_LIMIT = 100;
const MAX_RELATIONAL_NODE_DEPTH = 128;

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

    function decodeUtf16(value) {
        const bytes = Buffer.from(String(value), 'base64');
        if (bytes.length % 2 !== 0) throw new Error('Invalid UTF-16 relational node value');
        let result = '';
        for (let index = 0; index < bytes.length; index += 2) {
            result += String.fromCharCode(bytes[index] | (bytes[index + 1] << 8));
        }
        return result;
    }

    function decodedText(text, encoded) {
        return encoded !== null && encoded !== undefined
            ? decodeUtf16(encoded)
            : String(text ?? '');
    }

    function rebuildRelationalValue(input) {
        if (!input.length) throw new Error('Relational value has no root node');
        const rows = [...input].sort((left, right) => Number(left.node_id) - Number(right.node_id));
        if (Number(rows[0].node_id) !== 0 || rows[0].parent_node_id !== null) {
            throw new Error('Relational value has an invalid root node');
        }
        const children = new Map();
        for (const row of rows.slice(1)) {
            const parent = Number(row.parent_node_id);
            if (!Number.isSafeInteger(parent)) throw new Error('Relational node has no parent');
            const list = children.get(parent) || [];
            list.push(row);
            children.set(parent, list);
        }
        for (const list of children.values()) {
            list.sort((left, right) => Number(left.node_order) - Number(right.node_order));
        }
        const build = (row, depth) => {
            if (depth > MAX_RELATIONAL_NODE_DEPTH) throw new Error('Relational value exceeds maximum depth');
            switch (row.value_type) {
                case 'null': return null;
                case 'undefined': return undefined;
                case 'boolean': return Boolean(row.boolean_value);
                case 'number':
                    if (row.text_value === 'NaN') return Number.NaN;
                    if (row.text_value === 'Infinity') return Number.POSITIVE_INFINITY;
                    if (row.text_value === '-Infinity') return Number.NEGATIVE_INFINITY;
                    return Number(row.number_value);
                case 'string': return decodedText(row.text_value, row.encoded_text_value);
                case 'array': return (children.get(Number(row.node_id)) || []).map((child) => build(child, depth + 1));
                case 'object': {
                    const result = {};
                    for (const child of children.get(Number(row.node_id)) || []) {
                        Object.defineProperty(result, decodedText(child.object_key, child.object_key_encoded), {
                            value: build(child, depth + 1), enumerable: true, configurable: true, writable: true,
                        });
                    }
                    return result;
                }
                default: throw new Error(`Unknown relational node type: ${String(row.value_type)}`);
            }
        };
        return build(rows[0], 0);
    }

    function inReadTransaction(read) {
        database.exec('BEGIN DEFERRED');
        try {
            const value = read();
            database.exec('COMMIT');
            return value;
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch {}
            throw error;
        }
    }

    function readNodeValue(table, whereSql, bind) {
        const rows = database.prepare(`SELECT * FROM ${table} WHERE ${whereSql} ORDER BY node_id`).all(...bind);
        return rows.length ? rebuildRelationalValue(rows) : undefined;
    }

    function loadChatSummaryRows(characterId) {
        const where = characterId === undefined ? '' : 'WHERE c.character_id = ?';
        const rows = database.prepare(
            `SELECT c.id, c.character_id, c.position, c.name, c.note, c.folder_id, c.last_message_time,
                    COUNT(m.id) AS message_total
             FROM chats c LEFT JOIN messages m ON m.chat_id = c.id ${where}
             GROUP BY c.id ORDER BY c.character_id, c.position`,
        ).all(...(characterId === undefined ? [] : [characterId]));
        return rows;
    }

    function loadChatSummaryRow(chatId) {
        return database.prepare(
            `SELECT c.id, c.character_id, c.position, c.name, c.note, c.folder_id, c.last_message_time,
                    COUNT(m.id) AS message_total
             FROM chats c LEFT JOIN messages m ON m.chat_id = c.id
             WHERE c.id = ? GROUP BY c.id`,
        ).get(chatId);
    }

    function summaryChat(row, detailsLoaded) {
        return {
            id: row.id,
            name: row.name,
            note: row.note,
            folderId: row.folder_id ?? undefined,
            lastDate: row.last_message_time ?? undefined,
            message: [],
            messageTotal: Number(row.message_total),
            messagesLoaded: false,
            messagesFullyLoaded: false,
            detailsLoaded,
        };
    }

    function bootstrap() {
        return inReadTransaction(() => {
            const placeholders = BOOTSTRAP_SETTING_KEYS.map(() => '?').join(',');
            const settingRows = database.prepare(`SELECT key FROM system_settings WHERE key IN (${placeholders})`).all(...BOOTSTRAP_SETTING_KEYS);
            const settings = Object.fromEntries(settingRows.map((row) => [
                row.key, readNodeValue('setting_extension_nodes', 'setting_key = ?', [row.key]),
            ]));
            const chatsByCharacter = new Map();
            for (const row of loadChatSummaryRows()) {
                const chats = chatsByCharacter.get(row.character_id) || [];
                chats.push(summaryChat(row, false));
                chatsByCharacter.set(row.character_id, chats);
            }
            const characters = database.prepare('SELECT * FROM characters ORDER BY position').all().map((row) => ({
                chaId: row.id,
                type: row.kind,
                name: row.name,
                image: row.image ?? '',
                trashTime: row.trash_time ?? undefined,
                creationDate: row.creation_time ?? undefined,
                modificationDate: row.modification_time ?? undefined,
                lastInteraction: row.last_interaction_time ?? undefined,
                detailsLoaded: false,
                chats: chatsByCharacter.get(row.id) || [],
                chatPage: 0,
            }));
            const initialized = database.prepare('SELECT initialized FROM system_storage_meta WHERE singleton = 1').get();
            return {
                status: Number(initialized?.initialized) === 1 ? 'ready' : 'empty',
                revision: revision(), settings, pluginCustomStorage: {}, botPresets: [], characters,
                selectedCharacterId: null, selectedChatId: null,
            };
        });
    }

    function loadCharacter(characterId) {
        return inReadTransaction(() => {
            if (!database.prepare('SELECT 1 FROM characters WHERE id = ?').get(characterId)) return null;
            const character = readNodeValue('character_extension_nodes', 'character_id = ?', [characterId]) || {};
            character.chaId = characterId;
            character.detailsLoaded = true;
            character.chats = loadChatSummaryRows(characterId).map((row) => summaryChat(row, true));
            return { revision: revision(), character };
        });
    }

    function loadChat(chatId) {
        return inReadTransaction(() => {
            const row = loadChatSummaryRow(chatId);
            if (!row) return null;
            const chat = readNodeValue('chat_extension_nodes', 'chat_id = ?', [chatId]) || {};
            Object.assign(chat, summaryChat(row, true));
            return { revision: revision(), chat };
        });
    }

    function loadChatMessages(chatId, before, requestedLimit) {
        return inReadTransaction(() => {
            if (!database.prepare('SELECT 1 FROM chats WHERE id = ?').get(chatId)) return null;
            if (before !== undefined && (!Number.isSafeInteger(before) || before < 0)) {
                throw new Error('Invalid before cursor');
            }
            const limit = Math.min(MAX_MESSAGE_PAGE_LIMIT, Math.max(1,
                Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : DEFAULT_MESSAGE_PAGE_LIMIT));
            const total = Number(database.prepare('SELECT COUNT(*) AS total FROM messages WHERE chat_id = ?').get(chatId).total);
            const normalizedBefore = before ?? Number(database.prepare(
                'SELECT COALESCE(MAX(position) + 1, 0) AS cursor FROM messages WHERE chat_id = ?',
            ).get(chatId).cursor);
            const descendingRows = database.prepare(
                'SELECT id, position FROM messages WHERE chat_id = ? AND position < ? ORDER BY position DESC LIMIT ?',
            ).all(chatId, normalizedBefore, limit);
            const ids = descendingRows.map((row) => row.id);
            const nodeRows = ids.length
                ? database.prepare(`SELECT * FROM message_extension_nodes WHERE chat_id = ? AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY message_id, node_id`).all(chatId, ...ids)
                : [];
            const byId = new Map();
            for (const row of nodeRows) {
                const group = byId.get(row.message_id) || [];
                group.push(row);
                byId.set(row.message_id, group);
            }
            const rows = descendingRows.reverse();
            const messages = rows.map((row) => ({
                ...(rebuildRelationalValue(byId.get(row.id) || []) || {}), chatId: row.id,
            }));
            const nextBefore = rows.length ? Math.min(...rows.map((row) => Number(row.position))) : null;
            return {
                revision: revision(), chatId, messages, before: before ?? null, nextBefore, total,
                hasMore: nextBefore !== null && nextBefore > 0,
            };
        });
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

    return {
        databasePath, revision, dump, bootstrap, loadCharacter, loadChat, loadChatMessages,
        commit, checkpoint, reset, close,
    };
}

module.exports = {
    TABLES,
    createRelationalSqlite,
    statementTable,
};
