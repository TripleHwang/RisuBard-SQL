'use strict';

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

module.exports = {
    normalizeSqlMessagePageQuery,
    normalizeSqlAncillaryLimitQuery,
    normalizeSqlSearchQuery,
    normalizeSqlCharacterSearchQuery,
    normalizeSqlReadKey,
    normalizeSqlAncillaryPageQuery,
};
