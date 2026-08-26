import { describe, expect, it } from 'vitest'

const {
    normalizeSqlMessagePageQuery,
    normalizeSqlAncillaryLimitQuery,
    normalizeSqlSearchQuery,
    normalizeSqlCharacterSearchQuery,
    normalizeSqlAncillaryPageQuery,
} = require('./sql-read-route-params.cjs')

describe('normalizeSqlMessagePageQuery', () => {
    it('accepts an omitted before cursor and an adapter-normalizable numeric limit', () => {
        expect(normalizeSqlMessagePageQuery({ limit: '3.5' })).toEqual({
            before: undefined,
            limit: 3.5,
        })
    })

    it.each([
        ['', 'empty'],
        [' ', 'whitespace'],
        ['abc', 'non-numeric'],
        ['Infinity', 'infinite'],
        ['-1', 'negative'],
        [['1', '2'], 'multiple values'],
        [{ valueOf: () => 1 }, 'object'],
    ])('rejects an invalid before cursor: %s', (before) => {
        expect(normalizeSqlMessagePageQuery({ before })).toEqual({
            error: 'Invalid before cursor',
        })
    })

    it.each([
        ['', 'empty'],
        [' ', 'whitespace'],
        ['abc', 'non-numeric'],
        ['Infinity', 'infinite'],
        [['1', '2'], 'multiple values'],
        [{ valueOf: () => 1 }, 'object'],
    ])('rejects an invalid message page limit: %s', (limit) => {
        expect(normalizeSqlMessagePageQuery({ limit })).toEqual({
            error: 'Invalid message page limit',
        })
    })
})

describe('bounded ancillary SQL read query parsers', () => {
    it('clamps list and search limits before they reach a reader', () => {
        expect(normalizeSqlAncillaryLimitQuery({ limit: '999' })).toEqual({ limit: 100 })
        expect(normalizeSqlSearchQuery({ query: 'hello', limit: '999' })).toEqual({ query: 'hello', limit: 100 })
    })

    it.each([undefined, '', ' ', ['hello'], 'x'.repeat(257)])('rejects a missing or invalid search query', (query) => {
        expect(normalizeSqlSearchQuery({ query })).toEqual({ error: 'Invalid search query' })
    })

    it.each(['0', '-1', '3.5', 'Infinity', ['2']])('rejects invalid bounded list limits', (limit) => {
        expect(normalizeSqlAncillaryLimitQuery({ limit })).toEqual({ error: 'Invalid limit' })
    })

    it('requires a name or tag character-search mode', () => {
        expect(normalizeSqlCharacterSearchQuery({ mode: 'tag', query: 'fantasy', limit: '2' })).toEqual({
            mode: 'tag', query: 'fantasy', limit: 2,
        })
        expect(normalizeSqlCharacterSearchQuery({ mode: 'all', query: 'fantasy' })).toEqual({
            error: 'Invalid character search mode',
        })
    })

    it('accepts only nonblank bounded route keys', () => {
        const { normalizeSqlReadKey } = require('./sql-read-route-params.cjs')
        expect(normalizeSqlReadKey('draft-1')).toEqual({ key: 'draft-1' })
        expect(normalizeSqlReadKey(' ')).toEqual({ error: 'Invalid key' })
        expect(normalizeSqlReadKey('x'.repeat(257))).toEqual({ error: 'Invalid key' })
    })

    it('accepts a bounded stable list cursor and clamps its limit', () => {
        expect(normalizeSqlAncillaryPageQuery({ after: 'draft-099', limit: '999' })).toEqual({
            after: 'draft-099', limit: 100,
        })
        expect(normalizeSqlAncillaryPageQuery({})).toEqual({ after: undefined, limit: 100 })
    })

    it.each(['', ' ', ['draft-1'], 'x'.repeat(257)])('rejects invalid list cursors', (after) => {
        expect(normalizeSqlAncillaryPageQuery({ after })).toEqual({ error: 'Invalid cursor' })
    })
})
