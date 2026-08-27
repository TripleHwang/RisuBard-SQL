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
//
// The cardinal rule: a reason may only claim as much as was actually
// EXAMINED. The previous two-code set violated this. `anyCandidateDecoded`
// flipped true as soon as a single candidate decoded, so a run where the
// small backups decoded and every large one was rejected by the byte cap
// still reported `no-candidate` — whose message told the user their character
// was "not found in any backup". The empty-candidate-list case reported the
// same thing while having read nothing at all.
//
// Every code below is paired with the exact claim it licenses. Only
// ABSENT_FROM_ALL may say "not in any backup".
const REPAIR_UNAVAILABLE_REASON = {
    // No backup source exists on this installation at all. Nothing was
    // checked because there was nothing to check.
    // May claim: "there are no backups to recover from".
    NO_BACKUPS: 'no-backups',
    // Backups exist, but not one of them could be read: every candidate that
    // was attempted failed to decode (corrupt blob, over the decode budget,
    // timeout), and none were successfully searched.
    // May claim: "none of your N backups could be read". Must NOT claim the
    // character is absent — we never got to look.
    ALL_UNREADABLE: 'all-unreadable',
    // At least one backup was read and searched, and the character was not in
    // it — but coverage was incomplete: some backups failed to decode and/or
    // were never attempted (caller candidate budget, total-bytes budget, or
    // the overall decode time budget).
    // May claim: "not in the N we could check, and M could not be checked".
    // Must NOT claim the character is absent from every backup.
    ABSENT_FROM_EXAMINED: 'absent-from-examined',
    // Every backup that exists was read and searched, and none contained a
    // usable copy of this character. This is the ONLY code that has actually
    // established absence.
    // May claim: "not in any of your backups".
    ABSENT_FROM_ALL: 'absent-from-all',
};

// Overall wall-clock ceiling across ALL candidate decodes in one repair.
// Bounds the pathological case (many candidates each burning the per-candidate
// timeout) without cutting a single realistic decode short: the measured worst
// case for one 192MB backup is ~3.4s, so this permits a full sweep of the
// widened candidate list with room to spare. Candidates dropped by this budget
// are reported as `skipped`, never silently folded into "not found".
const DEFAULT_REPAIR_DECODE_BUDGET_MS = 90_000;

// Normalizes whatever `readBackupCandidates` returned into
// `{ candidates, total }`.
//
// Two accepted shapes:
//   Array<() => Promise<unknown>>              — legacy; total is assumed to
//                                                equal the list length, i.e.
//                                                "everything that exists was
//                                                offered".
//   { candidates: [...], total: number }       — preferred; `total` is how
//                                                many backup sources EXIST on
//                                                disk, which may exceed the
//                                                number offered because the
//                                                caller applies its own count
//                                                and byte budgets.
//
// That `total` is the whole point: without it the repair cannot tell "we read
// every backup you have and the character is not in any of them" apart from
// "we read the three we were handed and there are twelve more we never
// opened". Those two deserve very different messages.
function normalizeCandidateSource(raw) {
    if (Array.isArray(raw)) return { candidates: raw, total: raw.length };
    if (raw && typeof raw === 'object' && Array.isArray(raw.candidates)) {
        const offered = raw.candidates.length;
        const declared = Number(raw.total);
        // `total` can never be less than what was actually offered.
        const total = Number.isFinite(declared) ? Math.max(offered, Math.trunc(declared)) : offered;
        return { candidates: raw.candidates, total };
    }
    return { candidates: [], total: 0 };
}

// Derives the reason code from what was genuinely examined. Kept as a pure
// function so the "what may this claim" contract is testable in isolation and
// cannot drift from the loop that produces the counts.
function unavailableReasonFor({ total, examined }) {
    if (total === 0) return REPAIR_UNAVAILABLE_REASON.NO_BACKUPS;
    // Nothing was successfully searched, so nothing may be said about whether
    // the character is in a backup — whether the candidates failed to decode
    // or were never opened at all.
    if (examined === 0) return REPAIR_UNAVAILABLE_REASON.ALL_UNREADABLE;
    // Absence is only established when coverage was complete: every backup
    // that exists was decoded and searched. `examined === total` implies
    // nothing was unreadable and nothing was skipped, since the three always
    // sum to `total`.
    if (examined === total) return REPAIR_UNAVAILABLE_REASON.ABSENT_FROM_ALL;
    return REPAIR_UNAVAILABLE_REASON.ABSENT_FROM_EXAMINED;
}

/**
 * `readBackupCandidates` returns either an array of thunks —
 * `Array<() => Promise<unknown>>` — or `{ candidates, total }` (see
 * `normalizeCandidateSource`), in deterministic priority order (most-trusted
 * source first). Each thunk is tried in order and MUST independently resolve
 * to either a decoded backup object (`{ characters: [...] }`) or a falsy value
 * / thrown error on failure. The offered list is expected to already be
 * bounded (file count + total decoded-size budget) by the caller that builds
 * it; this function adds only an overall wall-clock decode budget on top.
 *
 * Per candidate, a decode failure, a missing/mismatched `chaId`, or an empty
 * body all just mean "try the next candidate" — none of them abort the
 * overall repair. The FIRST candidate that has both an exact `chaId` match
 * and a meaningful body is applied atomically; later candidates are never
 * consulted once one is chosen, and fields are never merged across multiple
 * backups.
 *
 * On failure the result carries a `backups` census that always satisfies
 * `total === examined + unreadable + skipped`:
 *   total      — backup sources that exist on this installation
 *   examined   — decoded successfully and searched for this character
 *   unreadable — attempted but failed to decode
 *   skipped    — never attempted (caller budget, or the decode time budget)
 */
function createSqlCharacterRepair({ relationalSql, readBackupCandidates, decodeBudgetMs = DEFAULT_REPAIR_DECODE_BUDGET_MS, now = Date.now }) {
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

        let source;
        try { source = normalizeCandidateSource(await readBackupCandidates()); } catch { source = { candidates: [], total: 0 }; }
        const { candidates, total } = source;

        // Census of what this run actually did. `skipped` is derived at the
        // end rather than incremented, so it always absorbs both "never
        // offered by the caller" and "offered but cut off by the time budget"
        // and the three counts are guaranteed to sum to `total`.
        let examined = 0;
        let unreadable = 0;
        const startedAt = now();

        for (const readCandidate of candidates) {
            // Stop opening NEW candidates once the overall budget is spent.
            // Anything left is reported as skipped — the user is told their
            // remaining backups went unchecked instead of being told the
            // character is not in them.
            if (now() - startedAt >= decodeBudgetMs) break;
            let backup;
            try { backup = await readCandidate(); } catch { unreadable += 1; continue; }
            // A falsy resolution is `readBoundedRisuSave` reporting a bounded
            // decode failure (over budget, corrupt, timed out). It means this
            // backup was NOT searched, so it must count as unreadable, never
            // as evidence of absence.
            if (!backup) { unreadable += 1; continue; }
            examined += 1;
            const characters = Array.isArray(backup?.characters) ? backup.characters : null;
            // Decoded but structurally unusable: it WAS read, so it stays
            // counted as examined — we genuinely established this backup does
            // not hold the character.
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

        // No applicable match. Report the reason that matches what was
        // actually examined, plus the census, so the client can word the
        // failure without overstating the search. The SQL row is untouched —
        // `relationalSql.commit` is only ever reached on a match above.
        const skipped = Math.max(0, total - examined - unreadable);
        return {
            status: 'unavailable',
            revision: current.revision,
            reason: unavailableReasonFor({ total, examined, unreadable }),
            backups: { total, examined, unreadable, skipped },
        };
    }
    return { repair };
}

module.exports = {
    createSqlCharacterRepair,
    isCollapsedCharacter,
    REPAIR_UNAVAILABLE_REASON,
    DEFAULT_REPAIR_DECODE_BUDGET_MS,
    unavailableReasonFor,
    normalizeCandidateSource,
};
