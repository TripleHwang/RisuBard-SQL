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

// `system_migration_sessions` is deliberately absent from TABLES. It is server
// bookkeeping, not user data, so it stays out of `dump()`; and because
// WRITABLE_TABLES is derived from TABLES, no client-supplied statement can ever
// reach it. Only `commit()` writes it, in the same transaction as the chunk.
const WRITABLE_TABLES = new Set(TABLES.filter((table) => (
    table !== 'system_storage_meta' && table !== 'system_revisions'
)));
// Bounds per-request memory: one commit is parsed and held whole before it is
// applied. It is NOT a ceiling on how much can be migrated -- a migration
// larger than this lands as a sequence of chunked commits; see `commit()`.
const MAX_STATEMENTS_PER_COMMIT = 250_000;
const MAX_MIGRATION_ID_LENGTH = 128;
const MAX_MIGRATION_CHUNKS = 100_000;
const DEFAULT_MESSAGE_PAGE_LIMIT = 40;
const MAX_MESSAGE_PAGE_LIMIT = 100;
const MAX_RELATIONAL_NODE_DEPTH = 128;
// The client's `RELATIONAL_JSON_NODE_KEY`. A value too large to explode into one
// row per scalar is stored as a single row whose text is the whole value as
// canonical JSON, marked by an `object_key` on the ROOT node -- a slot a
// flattened root never occupies, so this needs no new column, no new
// `value_type` (every CHECK constraint pins the list at seven) and no schema
// version bump. The two readers MUST agree: this file serves the bootstrap that
// every launch reads, and `relationalNodeCodec.ts` writes it.
const RELATIONAL_JSON_NODE_KEY = '__risuRelationalJson';
const MAX_SQL_READ_KEY_LENGTH = 256;
const MAX_SQL_READ_LIMIT = 100;
const MAX_DEFERRED_ROOT_KEYS = 512;
// Root keys the client Database exposes as ordinary properties but that are not
// stored in `system_settings`; each has its own table. Their probe answers one
// question only: does this root exist in storage at all?
const COLLECTION_ROOT_PROBES = new Map([
    ['characters', 'SELECT 1 FROM characters LIMIT 1'],
    ['pluginCustomStorage', 'SELECT 1 FROM plugin_custom_storage LIMIT 1'],
    ['botPresets', 'SELECT 1 FROM bot_presets LIMIT 1'],
]);
// `messages` has no timestamp index in schema v3. rowid DESC is an implicit
// SQLite primary-key traversal, so this candidate cap cannot trigger a full
// table sort before the limit; final relevance ordering happens afterward.
const MAX_MESSAGE_SEARCH_SCAN_ROWS = 50_000;

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

function sqlError(message, code, status, extra) {
    const error = new Error(message);
    error.code = code;
    error.status = status;
    if (extra) Object.assign(error, extra);
    return error;
}

/**
 * The `migration` field of a commit payload, or null for an ordinary commit.
 *
 * A migration chunk names the sequence it belongs to (`id`), its 0-based
 * position in that sequence (`chunk`), and whether it is the last one
 * (`final`). `totalChunks` is optional and exists only so the server can report
 * progress back; nothing depends on it being present.
 *
 * Every field is validated before anything is written. An unparseable migration
 * descriptor is a 400, never a silently-ignored field -- a commit that was meant
 * to be one chunk of a sequence must not be applied as a complete database.
 */
function normalizeMigrationChunk(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw sqlError('Invalid SQL migration descriptor', 'SQL_MIGRATION_INVALID', 400);
    }
    const id = raw.id;
    if (typeof id !== 'string' || id.trim().length === 0 || id.length > MAX_MIGRATION_ID_LENGTH) {
        throw sqlError('Invalid SQL migration id', 'SQL_MIGRATION_INVALID', 400);
    }
    const chunk = raw.chunk;
    if (!Number.isSafeInteger(chunk) || chunk < 0 || chunk >= MAX_MIGRATION_CHUNKS) {
        throw sqlError('Invalid SQL migration chunk index', 'SQL_MIGRATION_INVALID', 400);
    }
    if (typeof raw.final !== 'boolean') {
        throw sqlError('Invalid SQL migration chunk terminator', 'SQL_MIGRATION_INVALID', 400);
    }
    let totalChunks = null;
    if (raw.totalChunks !== undefined && raw.totalChunks !== null) {
        totalChunks = raw.totalChunks;
        if (!Number.isSafeInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_MIGRATION_CHUNKS) {
            throw sqlError('Invalid SQL migration chunk total', 'SQL_MIGRATION_INVALID', 400);
        }
        if (chunk >= totalChunks) {
            throw sqlError('SQL migration chunk index exceeds its total', 'SQL_MIGRATION_INVALID', 400);
        }
        if (raw.final !== (chunk === totalChunks - 1)) {
            throw sqlError('SQL migration chunk contradicts its total', 'SQL_MIGRATION_INVALID', 400);
        }
    }
    return { id, chunk, final: raw.final, totalChunks };
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
            // Non-null when a chunked migration is in flight. 'empty' plus a
            // migration means INCOMPLETE, which is not the same fact as empty.
            migration: migrationState(),
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
        if (rows.length === 1
            && rows[0].object_key === RELATIONAL_JSON_NODE_KEY
            && rows[0].value_type === 'string') {
            return JSON.parse(decodedText(rows[0].text_value, rows[0].encoded_text_value));
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

    function requireBoundedReadKey(value, description) {
        if (typeof value !== 'string' || value.trim().length === 0 || value.length > MAX_SQL_READ_KEY_LENGTH) {
            throw new Error(`Invalid ${description}`);
        }
        return value;
    }

    function boundedReadLimit(value, fallback) {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return fallback;
        return Math.min(MAX_SQL_READ_LIMIT, Math.max(1, Math.floor(numeric)));
    }

    function escapeSqlLike(value) {
        return String(value).replace(/[\\%_]/g, '\\$&');
    }

    function parseCanonicalJson(value, description) {
        try {
            return JSON.parse(String(value));
        } catch (error) {
            throw new Error(`Invalid canonical JSON in ${description}`, { cause: error });
        }
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

    function readBotPresets() {
        return database.prepare(
            'SELECT preset_id, data FROM bot_presets ORDER BY position',
        ).all().map((row) => {
            const preset = parseCanonicalJson(row.data, `bot preset ${row.preset_id}`);
            if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
                throw new Error(`Invalid canonical bot preset data for ${row.preset_id}`);
            }
            return { ...preset, id: row.preset_id };
        });
    }

    function readPluginCustomStorage() {
        const pluginCustomStorage = Object.create(null);
        for (const row of database.prepare(
            'SELECT key, value FROM plugin_custom_storage ORDER BY key',
        ).all()) {
            Object.defineProperty(pluginCustomStorage, row.key, {
                value: parseCanonicalJson(row.value, `plugin custom storage ${row.key}`),
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
        return pluginCustomStorage;
    }

    /**
     * One plugin storage row, by primary key.
     *
     * Existence and value are separate facts here for the same reason
     * `loadRootKey` keeps them separate: `present: true` with `value: null` is
     * a stored null, and `present: false` is the only answer that means the row
     * is not in the table. A caller that collapses the two writes over data it
     * simply did not read.
     */
    function loadPluginStorageKey(key) {
        return inReadTransaction(() => {
            const storageKey = requireBoundedReadKey(key, 'plugin storage key');
            const currentRevision = revision();
            const row = database.prepare(
                'SELECT value FROM plugin_custom_storage WHERE key = ?',
            ).get(storageKey);
            if (!row) {
                return { revision: currentRevision, key: storageKey, present: false };
            }
            return {
                revision: currentRevision,
                key: storageKey,
                present: true,
                value: parseCanonicalJson(row.value, `plugin custom storage ${storageKey}`),
            };
        });
    }

    /**
     * Every plugin storage key, and no values.
     *
     * Enumeration is all-or-nothing by contract: `pluginStorage.keys()`,
     * `length()` and `key(index)` all answer "these are all the keys there
     * are", and a short list is indistinguishable from a complete one at the
     * call site. So this is deliberately unpaginated -- the key column of a few
     * thousand rows is kilobytes, while the values it omits are the hundreds of
     * megabytes this route exists to avoid.
     */
    function listPluginStorageKeys() {
        return inReadTransaction(() => ({
            revision: revision(),
            keys: database.prepare(
                'SELECT key FROM plugin_custom_storage ORDER BY key',
            ).all().map((row) => row.key),
        }));
    }

    function readCharacterSummaries() {
        const chatsByCharacter = new Map();
        for (const row of loadChatSummaryRows()) {
            const chats = chatsByCharacter.get(row.character_id) || [];
            chats.push(summaryChat(row, false));
            chatsByCharacter.set(row.character_id, chats);
        }
        return database.prepare('SELECT * FROM characters ORDER BY position').all().map((row) => ({
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
    }

    function normalizeDeferredRootKeys(requested) {
        if (requested === undefined || requested === null) return new Set();
        if (typeof requested === 'string' || typeof requested?.[Symbol.iterator] !== 'function') {
            throw new Error('Invalid deferred root key list');
        }
        const keys = new Set();
        for (const entry of requested) {
            if (typeof entry !== 'string') throw new Error('Invalid deferred root key');
            // The deferral registry ignores empty keys; nothing can be deferred
            // under a name that is not a name.
            if (entry.trim().length === 0) continue;
            requireBoundedReadKey(entry, 'deferred root key');
            keys.add(entry);
        }
        if (keys.size > MAX_DEFERRED_ROOT_KEYS) throw new Error('Too many deferred root keys');
        return keys;
    }

    /** Does this root key exist in storage? Never reads or rebuilds its value. */
    function rootKeyExists(key) {
        const probe = COLLECTION_ROOT_PROBES.get(key);
        if (probe !== undefined) return Boolean(database.prepare(probe).get());
        return Boolean(database.prepare('SELECT 1 FROM system_settings WHERE key = ?').get(key));
    }

    /**
     * `options.deferRootKeys` names root keys the caller will hydrate later
     * through `loadRootKey`. A deferred key's value is never read or
     * reassembled — skipping that work is the point — and the payload says so.
     *
     * The invariant every consumer depends on: a key listed in
     * `deferredRootKeys` EXISTS in storage. A requested key that is not stored
     * is reported in `absentDeferredRootKeys` and is deliberately NOT deferred,
     * so "missing from the payload and missing from `deferredRootKeys`" is the
     * only shape that means "genuinely not stored". Partial knowledge never
     * leaves this function dressed up as a definite negative.
     *
     * `unreadableRootKeys` carries the third state: registered in
     * `system_settings` but rebuilding to no value. That is a storage fault, not
     * a deletion, and it stays visible instead of vanishing into JSON.
     */
    /**
     * Section timings for bootstrap(), off unless RISUVAULT_BOOTSTRAP_PROFILE=1.
     * bootstrap() assembles every settings key, every bot preset blob, every
     * plugin storage row and every character summary into one response, and
     * which of those dominates decides what is worth deferring. Measuring beats
     * guessing there: optimising the wrong section costs the same effort and
     * buys nothing.
     */
    const NEWLINE = String.fromCharCode(10);

    function profileBootstrapSection(report, label, run) {
        if (!report) return run();
        const started = performance.now();
        const value = run();
        report.push({
            label,
            ms: Number((performance.now() - started).toFixed(2)),
            bytes: JSON.stringify(value ?? null).length,
        });
        return value;
    }

    function bootstrap(options) {
        const requestedDeferrals = normalizeDeferredRootKeys(options?.deferRootKeys);
        return inReadTransaction(() => {
            const deferred = new Set();
            const absentDeferredRootKeys = [];
            for (const key of requestedDeferrals) {
                if (rootKeyExists(key)) deferred.add(key);
                else absentDeferredRootKeys.push(key);
            }
            const deferredRootKeys = [...deferred].sort();
            absentDeferredRootKeys.sort();

            const report = process.env.RISUVAULT_BOOTSTRAP_PROFILE === '1' ? [] : null;
            const startedAt = report ? performance.now() : 0;

            const unreadableRootKeys = [];
            const settings = profileBootstrapSection(report, 'settings', () => {
                const settingRows = database.prepare('SELECT key FROM system_settings ORDER BY key').all();
                return Object.fromEntries(settingRows
                    .filter((row) => !deferred.has(row.key))
                    .map((row) => {
                        const value = readNodeValue('setting_extension_nodes', 'setting_key = ?', [row.key]);
                        if (value === undefined) unreadableRootKeys.push(row.key);
                        return [row.key, value];
                    }));
            });
            if (unreadableRootKeys.length) {
                console.error(
                    '[SQL bootstrap] root keys are registered but hold no relational nodes:',
                    unreadableRootKeys.join(', '),
                );
            }

            const initialized = database.prepare('SELECT initialized FROM system_storage_meta WHERE singleton = 1').get();
            const payload = {
                status: Number(initialized?.initialized) === 1 ? 'ready' : 'empty',
                revision: revision(),
                settings,
                selectedCharacterId: null,
                selectedChatId: null,
                deferredRootKeys,
                absentDeferredRootKeys,
                unreadableRootKeys,
                // `status` alone cannot distinguish a database that was never
                // migrated from one whose migration is still only half applied:
                // both are 'empty', because neither is safe to read as
                // canonical. This says which of the two it is, and where a
                // resumed migration should pick up.
                migration: migrationState(),
            };
            if (!deferred.has('pluginCustomStorage')) {
                payload.pluginCustomStorage = profileBootstrapSection(report, 'pluginCustomStorage', readPluginCustomStorage);
            }
            if (!deferred.has('botPresets')) {
                payload.botPresets = profileBootstrapSection(report, 'botPresets', readBotPresets);
            }
            if (!deferred.has('characters')) {
                payload.characters = profileBootstrapSection(report, 'characters', readCharacterSummaries);
            }
            if (report) {
                const totalMs = performance.now() - startedAt;
                const rows = report
                    .map((entry) => `  ${entry.label.padEnd(20)} ${String(entry.ms).padStart(9)} ms  ${String(entry.bytes).padStart(11)} bytes`)
                    .join(NEWLINE);
                console.error(
                    `[bootstrap profile] total ${totalMs.toFixed(2)} ms, ` +
                    `${JSON.stringify(payload).length} bytes${NEWLINE}${rows}`,
                );
            }
            return payload;
        });
    }

    /**
     * Hydrate one root key on demand. Existence and value are reported as
     * separate facts: `present: true` with `value: null` is a stored null, and
     * `present: false` is the only answer that means the key is not stored. A
     * key that is registered but cannot be rebuilt throws rather than reporting
     * either one.
     */
    function loadRootKey(key) {
        return inReadTransaction(() => {
            const rootKey = requireBoundedReadKey(key, 'root key');
            const currentRevision = revision();
            if (COLLECTION_ROOT_PROBES.has(rootKey)) {
                if (!rootKeyExists(rootKey)) {
                    return { revision: currentRevision, key: rootKey, present: false };
                }
                const value = rootKey === 'characters'
                    ? readCharacterSummaries()
                    : rootKey === 'botPresets' ? readBotPresets() : readPluginCustomStorage();
                return { revision: currentRevision, key: rootKey, present: true, value };
            }
            if (!database.prepare('SELECT 1 FROM system_settings WHERE key = ?').get(rootKey)) {
                return { revision: currentRevision, key: rootKey, present: false };
            }
            const rows = database.prepare(
                'SELECT * FROM setting_extension_nodes WHERE setting_key = ? ORDER BY node_id',
            ).all(rootKey);
            if (!rows.length) {
                throw new Error(`Root key ${rootKey} is registered in system_settings without relational nodes`);
            }
            const value = rebuildRelationalValue(rows);
            if (value === undefined) {
                throw new Error(`Root key ${rootKey} rebuilt to undefined, which is not a storable root value`);
            }
            return { revision: currentRevision, key: rootKey, present: true, value };
        });
    }

    function loadCharacter(characterId) {
        return inReadTransaction(() => {
            if (!database.prepare('SELECT 1 FROM characters WHERE id = ?').get(characterId)) return null;
            const character = readNodeValue('character_extension_nodes', 'character_id = ?', [characterId]) || {};
            character.chaId = characterId;
            character.detailsLoaded = true;
            // `false`, because that is what these objects are. `loadCharacter`
            // reads `character_extension_nodes`; it never touches
            // `chat_extension_nodes`, so every chat here carries its name, note,
            // folder and timestamp and NOTHING else -- no `localLore`, no
            // `fmIndex`, no bound persona or preset, no memory data.
            //
            // Answering `true` over that was a second, independent lie of the
            // same family as the missing chat-detail read: it told the client
            // "this chat is fully loaded" about a summary, which is exactly the
            // state `buildSqlDirtyCommit`'s guard exists to refuse. With the
            // flag at `true` the guard would wave through every chat of any
            // character the user had opened, and the stub would be written back
            // over the real row anyway.
            character.chats = loadChatSummaryRows(characterId).map((row) => summaryChat(row, false));
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
            const nextPosition = Number(database.prepare(
                'SELECT COALESCE(MAX(position) + 1, 0) AS cursor FROM messages WHERE chat_id = ?',
            ).get(chatId).cursor);
            const normalizedBefore = before ?? Number(database.prepare(
                'SELECT COALESCE(MAX(position) + 1, 0) AS cursor FROM messages WHERE chat_id = ?',
            ).get(chatId).cursor);
            const descendingRows = database.prepare(
                'SELECT id, position FROM messages WHERE chat_id = ? AND position < ? ORDER BY position DESC, id DESC LIMIT ?',
            ).all(chatId, normalizedBefore, limit + 1);
            const extraRow = descendingRows[limit];
            const boundaryRow = descendingRows[limit - 1];
            if (extraRow && boundaryRow && Number(extraRow.position) === Number(boundaryRow.position)) {
                throw new Error('Reverse message page would split tied SQL positions');
            }
            const rows = descendingRows.slice(0, limit).reverse();
            const ids = rows.map((row) => row.id);
            const nodeRows = ids.length
                ? database.prepare(`SELECT * FROM message_extension_nodes WHERE chat_id = ? AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY message_id, node_id`).all(chatId, ...ids)
                : [];
            const byId = new Map();
            for (const row of nodeRows) {
                const group = byId.get(row.message_id) || [];
                group.push(row);
                byId.set(row.message_id, group);
            }
            const messages = rows.map((row) => ({
                ...(rebuildRelationalValue(byId.get(row.id) || []) || {}), chatId: row.id,
            }));
            const positions = rows.map((row) => Number(row.position));
            // `nextBefore` is the cursor for the *next* page, not a description
            // of this one: it is the `before` value a caller passes to keep
            // walking backwards. When `extraRow` is absent this page reached the
            // start of the history, there is no next page, and there is no
            // cursor -- so it is `null`, exactly as `SqlHydrationWindow`
            // documents ("`null` at the start of history").
            //
            // It used to be the minimum position of the returned rows whether or
            // not another page existed, which made the terminal page of every
            // chat longer than one page fail the client's boundary check and
            // surface as "이전 메시지를 불러오지 못했습니다" at the top of the
            // scrollback -- and, because the throw left `hasOlder` stuck true,
            // permanently hid the greeting as well.
            const nextBefore = extraRow && rows.length
                ? Math.min(...rows.map((row) => Number(row.position)))
                : null;
            return {
                revision: revision(), chatId, messages, positions, nextPosition, before: normalizedBefore, nextBefore, total,
                hasMore: Boolean(extraRow),
            };
        });
    }

    function getChatDraft(key) {
        return inReadTransaction(() => {
            const draftKey = requireBoundedReadKey(key, 'draft key');
            const row = database.prepare(
                'SELECT message_text, translate_text FROM chat_drafts WHERE draft_key = ?',
            ).get(draftKey);
            return row ? { m: row.message_text, t: row.translate_text } : null;
        });
    }

    function listChatDraftKeys(after, requestedLimit) {
        return inReadTransaction(() => {
            const afterKey = after === undefined ? undefined : requireBoundedReadKey(after, 'draft cursor');
            const limit = boundedReadLimit(requestedLimit, MAX_SQL_READ_LIMIT);
            const rows = database.prepare(
                `SELECT draft_key FROM chat_drafts ${afterKey === undefined ? '' : 'WHERE draft_key > ?'}
                 ORDER BY draft_key ASC LIMIT ?`,
            ).all(...(afterKey === undefined ? [limit + 1] : [afterKey, limit + 1]));
            const keys = rows.slice(0, limit).map((row) => row.draft_key);
            const hasMore = rows.length > limit;
            return { keys, nextAfter: hasMore ? keys.at(-1) : null, hasMore };
        });
    }

    function getColdStorageItem(key) {
        return inReadTransaction(() => {
            const archiveId = requireBoundedReadKey(key, 'cold storage key');
            if (!database.prepare('SELECT 1 FROM cold_archives WHERE archive_id = ?').get(archiveId)) return null;
            return readNodeValue('cold_extension_nodes', 'archive_id = ?', [archiveId]) ?? null;
        });
    }

    function listColdStorageItems(after, requestedLimit) {
        return inReadTransaction(() => {
            const afterKey = after === undefined ? undefined : requireBoundedReadKey(after, 'cold storage cursor');
            const limit = boundedReadLimit(requestedLimit, MAX_SQL_READ_LIMIT);
            const rows = database.prepare(
                `SELECT archive_id FROM cold_archives ${afterKey === undefined ? '' : 'WHERE archive_id > ?'}
                 ORDER BY archive_id ASC LIMIT ?`,
            ).all(...(afterKey === undefined ? [limit + 1] : [afterKey, limit + 1]));
            const items = rows.slice(0, limit).map((row) => row.archive_id);
            const hasMore = rows.length > limit;
            return { items, nextAfter: hasMore ? items.at(-1) : null, hasMore };
        });
    }

    function listRevisions(requestedLimit) {
        return inReadTransaction(() => database.prepare(
            `SELECT id, storage_revision, database_initialized, scope, action, restored_from_revision, created_at
             FROM system_revisions ORDER BY created_at DESC, id DESC LIMIT ?`,
        ).all(boundedReadLimit(requestedLimit, MAX_SQL_READ_LIMIT)).map((row) => ({
            id: Number(row.id),
            storage_revision: row.storage_revision == null ? null : Number(row.storage_revision),
            database_initialized: row.database_initialized == null ? null : Boolean(row.database_initialized),
            scope: row.scope,
            action: row.action,
            restored_from_revision: row.restored_from_revision == null ? null : Number(row.restored_from_revision),
            created_at: row.created_at,
            change_count: 0,
        })));
    }

    function searchMessages(query, requestedLimit) {
        return inReadTransaction(() => {
            const phrase = requireBoundedReadKey(query, 'message search query');
            const rows = database.prepare(
                `SELECT m.chat_id, m.id, m.position, m.role, m.sent_time, m.sender_name, m.content_text,
                        c.character_id, c.name AS chat_name, ch.name AS character_name
                 FROM (SELECT chat_id, id, position, role, sent_time, sender_name, content_text
                       FROM messages ORDER BY rowid DESC LIMIT ?) m
                 JOIN chats c ON c.id = m.chat_id
                 JOIN characters ch ON ch.id = c.character_id
                 WHERE m.content_text LIKE ? ESCAPE '\\' ORDER BY m.sent_time DESC, m.position DESC LIMIT ?`,
            ).all(MAX_MESSAGE_SEARCH_SCAN_ROWS, `%${escapeSqlLike(phrase)}%`, boundedReadLimit(requestedLimit, 50));
            return rows.map((row) => ({
                storageState: 'active', archiveId: null,
                characterId: row.character_id, characterName: row.character_name,
                chatId: row.chat_id, chatName: row.chat_name,
                messageId: row.id, position: Number(row.position), role: row.role,
                sentTime: row.sent_time == null ? null : Number(row.sent_time),
                senderName: row.sender_name ?? null,
                snippet: String(row.content_text ?? '').slice(0, 200),
            }));
        });
    }

    function characterSearchRows(whereSql, query, requestedLimit) {
        const phrase = requireBoundedReadKey(query, 'character search query');
        return database.prepare(
            `SELECT DISTINCT c.id, c.name, c.image, c.kind FROM characters c ${whereSql}
             ORDER BY c.position ASC LIMIT ?`,
        ).all(`%${escapeSqlLike(phrase)}%`, boundedReadLimit(requestedLimit, MAX_SQL_READ_LIMIT)).map((row) => ({
            id: row.id, name: row.name, image: row.image ?? null, kind: row.kind,
        }));
    }

    function searchCharactersByName(name, requestedLimit) {
        return inReadTransaction(() => characterSearchRows("WHERE c.name LIKE ? ESCAPE '\\'", name, requestedLimit));
    }

    function searchCharactersByTag(tag, requestedLimit) {
        return inReadTransaction(() => characterSearchRows(
            "JOIN character_tags t ON t.character_id = c.id WHERE t.tag LIKE ? ESCAPE '\\'", tag, requestedLimit,
        ));
    }

    // ── Chunked migrations ──────────────────────────────────────────────────
    //
    // A legacy-to-SQL migration is bigger than one request and always was: a
    // 50 MB `database.bin` builds ~350,000 statements against a 250,000
    // per-commit cap, so as a single commit it could never land at all. It
    // lands as a SEQUENCE of commits instead, and the bookkeeping below is what
    // keeps a half-applied sequence from ever being read as a finished one.
    //
    //   * `system_storage_meta.initialized` stays 0 for every chunk but the
    //     last. `bootstrap()` keeps answering 'empty', so the client keeps
    //     using its legacy source until the migration is genuinely complete.
    //   * `system_migration_sessions` holds one row for as long as a sequence
    //     is in flight. Its presence is the whole difference between "empty"
    //     and "incomplete"; `bootstrap().migration` reports it so the next
    //     launch can tell those apart and resume from `nextChunk`.
    //   * Each chunk is its own IMMEDIATE transaction and advances the session
    //     row inside that same transaction. A chunk that fails rolls back
    //     whole, leaving the chunks before it and the session row exactly as
    //     they were, so the client retries one chunk rather than the migration.
    //   * An ordinary (non-migration) commit is REFUSED while a session is
    //     open, because applying one would set `initialized = 1` over a
    //     half-applied database -- the exact state this design exists to
    //     prevent. Sending chunk 0 again supersedes an abandoned sequence.

    function readMigrationSession() {
        return database.prepare(
            'SELECT * FROM system_migration_sessions WHERE singleton = 1',
        ).get() || null;
    }

    function describeMigrationSession(row) {
        if (!row) return null;
        return {
            id: row.migration_id,
            action: row.action,
            chunksApplied: Number(row.chunks_applied),
            // Same number as `chunksApplied`, named for the caller's decision:
            // this is the 0-based index of the chunk the server will accept.
            nextChunk: Number(row.chunks_applied),
            statementsApplied: Number(row.statements_applied),
            totalChunks: row.total_chunks == null ? null : Number(row.total_chunks),
            baseRevision: Number(row.base_revision),
            replacedCompleteDatabase: Number(row.was_initialized) === 1,
            archivedPath: row.archived_path ?? null,
            startedAt: row.started_at,
            updatedAt: row.updated_at,
        };
    }

    /** The in-flight migration sequence, or null when none is in flight. */
    function migrationState() {
        return describeMigrationSession(readMigrationSession());
    }

    /**
     * A consistent copy of the database as it stands, taken before the first
     * chunk of a sequence overwrites a database that is already complete.
     *
     * A chunked replace-all is not atomic the way the old single commit was, so
     * the state it is about to destroy is captured first. `VACUUM INTO` writes
     * that copy without closing the live connection and cannot run inside a
     * transaction, which is why this happens before `BEGIN IMMEDIATE`.
     */
    function archiveBeforeMigration() {
        const archiveDirectory = path.join(dataRoot, 'migration-backups');
        fs.mkdirSync(archiveDirectory, { recursive: true });
        const archivedPath = path.join(
            archiveDirectory,
            `sql-pre-migration-${Date.now()}-${process.pid}.sqlite3`,
        );
        database.exec(`VACUUM INTO '${archivedPath.replace(/'/g, "''")}'`);
        return archivedPath;
    }

    function commit(payload) {
        const statements = Array.isArray(payload?.statements) ? payload.statements : [];
        if (statements.length > MAX_STATEMENTS_PER_COMMIT) {
            throw sqlError('SQL commit is too large', 'SQL_COMMIT_TOO_LARGE', 413, {
                maxStatementsPerCommit: MAX_STATEMENTS_PER_COMMIT,
            });
        }
        const migration = normalizeMigrationChunk(payload?.migration);
        const baseRevision = Number(payload?.baseRevision);
        const action = String(payload?.action || (migration ? 'migrate' : 'sync')).slice(0, 128);

        // Only when a first chunk is about to overwrite a database that is
        // actually finished, and never inside a transaction.
        let archivedPath = null;
        if (migration && migration.chunk === 0 && Number(database.prepare(
            'SELECT initialized FROM system_storage_meta WHERE singleton = 1',
        ).get()?.initialized) === 1) {
            archivedPath = archiveBeforeMigration();
        }

        database.exec('BEGIN IMMEDIATE');
        try {
            const currentRevision = revision();
            if (baseRevision !== currentRevision) {
                throw sqlError('SQL revision conflict', 'SQL_REVISION_CONFLICT', 409, {
                    currentRevision,
                });
            }
            const session = readMigrationSession();
            if (migration) {
                if (migration.chunk !== 0) {
                    if (!session) {
                        throw sqlError(
                            'No SQL migration is in progress',
                            'SQL_MIGRATION_NOT_FOUND', 409,
                            { expectedChunk: 0, currentRevision, migration: null },
                        );
                    }
                    if (session.migration_id !== migration.id) {
                        throw sqlError(
                            'A different SQL migration is in progress',
                            'SQL_MIGRATION_MISMATCH', 409,
                            {
                                expectedChunk: Number(session.chunks_applied),
                                currentRevision,
                                migration: describeMigrationSession(session),
                            },
                        );
                    }
                    if (Number(session.chunks_applied) !== migration.chunk) {
                        throw sqlError(
                            'SQL migration chunk is out of order',
                            'SQL_MIGRATION_SEQUENCE', 409,
                            {
                                expectedChunk: Number(session.chunks_applied),
                                currentRevision,
                                migration: describeMigrationSession(session),
                            },
                        );
                    }
                    // `final` is validated against the total the chunk itself
                    // declares, so a sequence opened as 18 chunks could be
                    // closed by a chunk claiming to be 2 of 2 -- marking a
                    // sixteen-chunk-short database `initialized`. The length of
                    // a migration is fixed when it opens.
                    if (
                        migration.totalChunks !== null &&
                        session.total_chunks !== null &&
                        Number(session.total_chunks) !== migration.totalChunks
                    ) {
                        throw sqlError(
                            'SQL migration chunk total changed mid-sequence',
                            'SQL_MIGRATION_INVALID', 409,
                            {
                                expectedChunk: Number(session.chunks_applied),
                                currentRevision,
                                migration: describeMigrationSession(session),
                            },
                        );
                    }
                }
                // chunk 0 needs no session: it starts one, and deliberately
                // supersedes an abandoned sequence, because chunk 0 of a
                // replace-all carries the DELETEs that clear what it left.
            } else if (session) {
                throw sqlError(
                    'A SQL migration is in progress',
                    'SQL_MIGRATION_IN_PROGRESS', 409,
                    {
                        expectedChunk: Number(session.chunks_applied),
                        currentRevision,
                        migration: describeMigrationSession(session),
                    },
                );
            }

            for (const entry of statements) {
                statementTable(entry?.sql);
                const bind = Array.isArray(entry?.bind) ? entry.bind : [];
                database.prepare(entry.sql).run(...bind);
            }
            const nextRevision = currentRevision + 1;
            // The one line the whole design turns on: a database counts as
            // initialized only when nothing is still on its way to it.
            const initialized = migration && !migration.final ? 0 : 1;
            database.prepare(
                `UPDATE system_storage_meta
                 SET revision = ?, initialized = ?, updated_at = datetime('now')
                 WHERE singleton = 1`,
            ).run(nextRevision, initialized);
            database.prepare(
                `INSERT INTO system_revisions
                 (storage_revision, database_initialized, scope, action, created_at)
                 VALUES (?, ?, 'database', ?, datetime('now'))`,
            ).run(nextRevision, initialized, action);

            let migrationSession = null;
            if (migration && migration.final) {
                database.prepare('DELETE FROM system_migration_sessions WHERE singleton = 1').run();
            } else if (migration) {
                const first = migration.chunk === 0;
                database.prepare(
                    `INSERT INTO system_migration_sessions
                       (singleton, migration_id, action, chunks_applied, statements_applied,
                        total_chunks, base_revision, was_initialized, archived_path,
                        started_at, updated_at)
                     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
                     ON CONFLICT (singleton) DO UPDATE SET
                        migration_id = excluded.migration_id,
                        action = excluded.action,
                        chunks_applied = excluded.chunks_applied,
                        statements_applied = excluded.statements_applied,
                        total_chunks = excluded.total_chunks,
                        base_revision = excluded.base_revision,
                        was_initialized = excluded.was_initialized,
                        archived_path = excluded.archived_path,
                        started_at = excluded.started_at,
                        updated_at = excluded.updated_at`,
                ).run(
                    migration.id,
                    action,
                    migration.chunk + 1,
                    (first ? 0 : Number(session.statements_applied)) + statements.length,
                    migration.totalChunks ?? (session ? session.total_chunks ?? null : null),
                    first ? currentRevision : Number(session.base_revision),
                    // An archive taken by an earlier attempt still describes the
                    // complete database this sequence replaced; a restart must
                    // not forget it just because `initialized` is already 0.
                    archivedPath ? 1 : Number(session?.was_initialized ?? 0),
                    archivedPath ?? (session ? session.archived_path ?? null : null),
                    // How long this database has been incomplete, which a
                    // restarted attempt inherits rather than resets.
                    session ? session.started_at : null,
                );
                migrationSession = describeMigrationSession(readMigrationSession());
            }
            database.exec('COMMIT');
            return {
                revision: nextRevision,
                initialized: initialized === 1,
                migration: migrationSession,
            };
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
        databasePath, revision, dump, bootstrap, loadRootKey, loadPluginStorageKey, listPluginStorageKeys,
        loadCharacter, loadChat, loadChatMessages,
        getChatDraft, listChatDraftKeys, getColdStorageItem, listColdStorageItems, listRevisions,
        searchMessages, searchCharactersByName, searchCharactersByTag,
        commit, migrationState, checkpoint, reset, close,
        maxStatementsPerCommit: MAX_STATEMENTS_PER_COMMIT,
        databasePath,
    };
}

module.exports = {
    TABLES,
    MAX_STATEMENTS_PER_COMMIT,
    normalizeMigrationChunk,
    COLLECTION_ROOT_KEYS: Object.freeze([...COLLECTION_ROOT_PROBES.keys()]),
    createRelationalSqlite,
    statementTable,
};
