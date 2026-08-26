import { describe, expect, it } from 'vitest'

const { normalizeSqlMessagePageQuery } = require('./sql-read-route-params.cjs')

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
