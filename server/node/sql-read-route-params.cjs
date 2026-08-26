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

module.exports = { normalizeSqlMessagePageQuery };
