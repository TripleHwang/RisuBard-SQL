'use strict';

const { nodeRows } = require('./sql-legacy-migration.cjs');

// `character_extension_nodes` is deliberately schemaless so new authored
// fields must be protected automatically. Only fields synthesized from the
// relational summary or runtime hydration are excluded from body detection.
const NON_BODY_KEYS = new Set([
    'chaId', 'type', 'name', 'image', 'trashTime', 'creationDate',
    'creation_date', 'modificationDate', 'modification_date', 'lastInteraction', 'lastInteractionTime', 'chats',
    'tags', 'detailsLoaded', 'chatPage', '_sqlCharacterBodyCollapsed',
    '_sqlHydrationRevision',
]);

function hasMeaningfulValue(value) {
    if (typeof value === 'string') return value.trim().length > 0;
    if (typeof value === 'number' || typeof value === 'boolean') return true;
    if (Array.isArray(value)) return value.some(hasMeaningfulValue);
    return Boolean(value && typeof value === 'object' && Object.values(value).some(hasMeaningfulValue));
}

function characterBody(value) {
    return Object.fromEntries(Object.entries(value || {}).filter(([key]) => !NON_BODY_KEYS.has(key)));
}

function hasBodyField(value) {
    // Presence, rather than a hand-maintained field list, is the collapsed
    // signal: every persisted extension node is authored data worth keeping.
    return Object.keys(characterBody(value)).length > 0;
}

function isCollapsedCharacter(value) {
    return Boolean(value && typeof value === 'object') && !hasBodyField(value);
}

function cleanBackupCharacter(value) {
    return characterBody(value);
}

function backupIsRicher(value) {
    const body = characterBody(value);
    return Object.keys(body).length > 0 && hasMeaningfulValue(body);
}

function extensionStatements(characterId, body) {
    const columns = ['character_id', 'node_id', 'parent_node_id', 'node_order', 'object_key', 'object_key_encoded', 'value_type', 'text_value', 'encoded_text_value', 'number_value', 'boolean_value'];
    const sql = `INSERT INTO character_extension_nodes (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
    return nodeRows(body).map((row) => ({ sql, bind: [characterId, ...columns.slice(1).map((column) => row[column] ?? null)] }));
}

function createSqlCharacterRepair({ relationalSql, readBackup }) {
    async function repair(characterId) {
        const current = relationalSql.loadCharacter(characterId);
        if (!current) return { status: 'not-needed', revision: relationalSql.revision() };
        if (!isCollapsedCharacter(current.character)) return { status: 'not-needed', revision: current.revision };
        let backup;
        try { backup = await readBackup(); } catch { return { status: 'unavailable', revision: current.revision }; }
        if (!backup) return { status: 'unavailable', revision: current.revision };
        const candidate = Array.isArray(backup?.characters) ? backup.characters.find((character) => character?.chaId === characterId) : null;
        if (!candidate || !backupIsRicher(candidate)) return { status: 'not-needed', revision: current.revision };
        const body = cleanBackupCharacter(candidate);
        const tags = Array.isArray(candidate.tags) ? candidate.tags.filter((tag) => typeof tag === 'string') : [];
        const statements = [
            { sql: 'DELETE FROM character_extension_nodes WHERE character_id = ?', bind: [characterId] },
            { sql: 'DELETE FROM character_tags WHERE character_id = ?', bind: [characterId] },
            ...extensionStatements(characterId, body),
            ...tags.map((tag, position) => ({ sql: 'INSERT INTO character_tags (character_id, position, tag) VALUES (?, ?, ?)', bind: [characterId, position, tag] })),
        ];
        const result = relationalSql.commit({ baseRevision: current.revision, action: 'repair-character-body', statements });
        return { status: 'repaired', revision: result.revision };
    }
    return { repair };
}

module.exports = { createSqlCharacterRepair, isCollapsedCharacter };
