import { describe, expect, it } from 'vitest'
import {
    normalizeNarrativeBaseline,
    parseSingleJsonObject,
} from './modelOutput'

describe('parseSingleJsonObject', () => {
    it('accepts strict JSON and JSON wrapped in reasoning or a markdown fence', () => {
        const value = { schemaVersion: 1, operations: [] }

        expect(parseSingleJsonObject(JSON.stringify(value))).toEqual(value)
        expect(parseSingleJsonObject(
            `<Thoughts>reasoning</Thoughts>\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``
        )).toEqual(value)
        expect(parseSingleJsonObject(
            `I will return the requested object.\n${JSON.stringify(value)}`
        )).toEqual(value)
    })

    it('ignores JSON-shaped provider reasoning before the final object', () => {
        const value = {
            schemaVersion: 2,
            storyId: 'character',
            branchId: 'chat',
            operations: [],
        }

        expect(parseSingleJsonObject(
            `<Thoughts>{"draft":true}</Thoughts>\n${JSON.stringify(value)}`
        )).toEqual(value)
    })

    it('rejects ambiguous multiple JSON objects and prose without JSON', () => {
        expect(() => parseSingleJsonObject('{}\n{}')).toThrow(/exactly one/)
        expect(() => parseSingleJsonObject('not json')).toThrow(/exactly one/)
    })
})

describe('normalizeNarrativeBaseline', () => {
    it('removes reasoning and markdown wrappers before persistence', () => {
        expect(normalizeNarrativeBaseline(
            '<Thoughts>private plan</Thoughts>\n```text\nCurrent state.\n```'
        )).toBe('Current state.')
    })

    it('rejects reasoning-only and oversized baselines', () => {
        expect(() => normalizeNarrativeBaseline(
            '<Thoughts>private plan</Thoughts>'
        )).toThrow(/empty/)
        expect(() => normalizeNarrativeBaseline('x'.repeat(12_001)))
            .toThrow(/12000/)
    })
})
