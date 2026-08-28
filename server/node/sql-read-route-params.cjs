'use strict';

const MAX_SQL_READ_KEY_LENGTH = 256;
const MAX_DEFERRED_ROOT_KEYS = 512;
// Keeps the deferral list well inside Node's default request-header budget.
const MAX_DEFER_QUERY_LENGTH = 8192;

function parseSingleFiniteNumber(value) {
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSqlMessagePageQuery(query) {
    const beforeValue = query.before;
    let before;
    if (beforeValue !== undefined) {
        before = parseSingleFiniteNumber(beforeValue);
        if (!Number.isSafeInteger(before) || before < 0) {
            return { error: 'Invalid before cursor' };
        }
    }

    const limitValue = query.limit;
    const limit = limitValue === undefined ? 40 : parseSingleFiniteNumber(limitValue);
    if (limit === null) return { error: 'Invalid message page limit' };

    return { before, limit };
}

function normalizeSqlAncillaryLimitQuery(query, fallback = 100) {
    const value = query.limit;
    if (value === undefined) return { limit: fallback };
    const limit = parseSingleFiniteNumber(value);
    if (!Number.isSafeInteger(limit) || limit < 1) return { error: 'Invalid limit' };
    return { limit: Math.min(100, limit) };
}

function normalizeSqlSearchQuery(query) {
    const phrase = query.query;
    if (typeof phrase !== 'string' || phrase.trim().length === 0 || phrase.length > 256) {
        return { error: 'Invalid search query' };
    }
    const limitQuery = normalizeSqlAncillaryLimitQuery(query, 50);
    return limitQuery.error ? limitQuery : { query: phrase, limit: limitQuery.limit };
}

function normalizeSqlCharacterSearchQuery(query) {
    if (query.mode !== 'name' && query.mode !== 'tag') return { error: 'Invalid character search mode' };
    const search = normalizeSqlSearchQuery(query);
    return search.error ? search : { mode: query.mode, ...search };
}

function normalizeSqlReadKey(value) {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) {
        return { error: 'Invalid key' };
    }
    return { key: value };
}

function normalizeSqlAncillaryPageQuery(query) {
    const after = query.after;
    if (after !== undefined && (typeof after !== 'string' || after.trim().length === 0 || after.length > 256)) {
        return { error: 'Invalid cursor' };
    }
    const limitQuery = normalizeSqlAncillaryLimitQuery(query);
    return limitQuery.error ? limitQuery : { after, limit: limitQuery.limit };
}

/**
 * `?defer=` names root keys the client already intends to hydrate later, either
 * as one comma separated list or as a repeated parameter. Nothing here decides
 * whether a key exists — only the storage layer may do that — so an unknown key
 * is passed through and comes back reported as absent rather than deferred.
 */
function normalizeSqlBootstrapQuery(query) {
    const raw = query.defer;
    if (raw === undefined) return { deferRootKeys: [] };
    const values = Array.isArray(raw) ? raw : [raw];
    const deferRootKeys = [];
    let queryLength = 0;
    for (const entry of values) {
        if (typeof entry !== 'string') return { error: 'Invalid deferred root key' };
        queryLength += entry.length;
        if (queryLength > MAX_DEFER_QUERY_LENGTH) return { error: 'Deferred root key list is too large' };
        for (const part of entry.split(',')) {
            const key = part.trim();
            if (key.length === 0) continue;
            if (key.length > MAX_SQL_READ_KEY_LENGTH) return { error: 'Invalid deferred root key' };
            deferRootKeys.push(key);
        }
    }
    if (deferRootKeys.length > MAX_DEFERRED_ROOT_KEYS) return { error: 'Too many deferred root keys' };
    return { deferRootKeys };
}

module.exports = {
    normalizeSqlBootstrapQuery,
    normalizeSqlMessagePageQuery,
    normalizeSqlAncillaryLimitQuery,
    normalizeSqlSearchQuery,
    normalizeSqlCharacterSearchQuery,
    normalizeSqlReadKey,
    normalizeSqlAncillaryPageQuery,
};
