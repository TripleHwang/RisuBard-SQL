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

// Reason codes attached to a `status: 'unavailable'` repair result. Kept as
// named constants (rather than inline strings) so the client and the two
// production call sites in server.cjs / sql-character-repair.cjs can't drift
// on spelling.
const REPAIR_UNAVAILABLE_REASON = {
    // The candidate list was empty, OR every candidate decoded fine but none
    // of them had an exact `chaId` match with a meaningful (non-collapsed)
    // body. Either way: nothing usable was found for this character.
    NO_CANDIDATE: 'no-candidate',
    // At least one candidate existed, but none of them could be decoded at
    // all (bounded-decode failure, corrupt blob, timeout, ...). Distinct from
    // NO_CANDIDATE because it signals a read/IO problem rather than "this
    // character genuinely isn't in any backup".
    DECODE_FAILED: 'decode-failed',
};

/**
 * `readBackupCandidates` returns an array of thunks — `Array<() => Promise<unknown>>` —
 * in deterministic priority order (most-trusted source first). Each thunk is
 * tried in order and MUST independently resolve to either a decoded backup
 * object (`{ characters: [...] }`) or a falsy value / thrown error on
 * failure. The list is expected to already be bounded (file count + total
 * decoded-size budget) by the caller that builds it — this function does not
 * impose its own limit beyond "try candidates in the order given".
 *
 * Per candidate, a decode failure, a missing/mismatched `chaId`, or an empty
 * body all just mean "try the next candidate" — none of them abort the
 * overall repair. The FIRST candidate that has both an exact `chaId` match
 * and a meaningful body is applied atomically; later candidates are never
 * consulted once one is chosen, and fields are never merged across multiple
 * backups.
 */
function createSqlCharacterRepair({ relationalSql, readBackupCandidates }) {
    async function repair(characterId) {
        const current = relationalSql.loadCharacter(characterId);
        if (!current) return { status: 'not-needed', revision: relationalSql.revision() };
        // The current row is already healthy — this is the ONLY condition
        // that yields 'not-needed'. A collapsed row that fails to find a
        // usable candidate below must resolve to 'unavailable' instead, never
        // silently fall back to 'not-needed' (that was the original bug: the
        // caller then re-read the still-collapsed row and threw anyway, with
        // no way to distinguish "already fine" from "could not be fixed").
        if (!isCollapsedCharacter(current.character)) return { status: 'not-needed', revision: current.revision };

        let candidates;
        try { candidates = await readBackupCandidates(); } catch { candidates = null; }
        if (!Array.isArray(candidates)) candidates = [];
        if (candidates.length === 0) {
            return { status: 'unavailable', revision: current.revision, reason: REPAIR_UNAVAILABLE_REASON.NO_CANDIDATE };
        }

        let anyCandidateDecoded = false;
        for (const readCandidate of candidates) {
            let backup;
            try { backup = await readCandidate(); } catch { continue; }
            if (!backup) continue;
            anyCandidateDecoded = true;
            const characters = Array.isArray(backup?.characters) ? backup.characters : null;
            if (!characters) continue;
            const candidate = characters.find((character) => character?.chaId === characterId);
            if (!candidate || !backupIsRicher(candidate)) continue;

            // Exact-ID match + meaningful body confirmed: apply this ONE
            // candidate atomically and stop. Never merge fields pulled from
            // more than one backup, and never touch other characters/chats.
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

        // Every candidate was exhausted without an applicable match. Distinguish
        // "we read backups but none had this character" from "we couldn't read
        // any backup at all" so the client can show/reason about them differently.
        return {
            status: 'unavailable',
            revision: current.revision,
            reason: anyCandidateDecoded ? REPAIR_UNAVAILABLE_REASON.NO_CANDIDATE : REPAIR_UNAVAILABLE_REASON.DECODE_FAILED,
        };
    }
    return { repair };
}

module.exports = { createSqlCharacterRepair, isCollapsedCharacter, REPAIR_UNAVAILABLE_REASON };
