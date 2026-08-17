import { describe, expect, test } from 'vitest'
import {
    createNarrativeSourceSnapshot,
    diffNarrativeSourceSnapshots,
    validateNarrativeSourceSnapshot,
} from './sourceSnapshot'

describe('narrative source snapshots', () => {
    test('creates a deterministic snapshot without retaining caller objects', () => {
        const sources = [
            {
                sourceId: 'lore-hoshino',
                kind: 'lorebook-entry' as const,
                content: '호시노는 누구도 쉽게 믿지 않는다.',
            },
            {
                sourceId: 'character-hoshino',
                kind: 'character-description' as const,
                content: '호시노는 20세 인간 여성이다.',
            },
        ]

        const snapshot = createNarrativeSourceSnapshot(sources)
        sources[0].content = 'mutated'

        expect(snapshot).toEqual({
            schemaVersion: 1,
            sources: [
                {
                    sourceId: 'character-hoshino',
                    kind: 'character-description',
                    content: '호시노는 20세 인간 여성이다.',
                    fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
                },
                {
                    sourceId: 'lore-hoshino',
                    kind: 'lorebook-entry',
                    content: '호시노는 누구도 쉽게 믿지 않는다.',
                    fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
                },
            ],
        })
        expect(createNarrativeSourceSnapshot([...sources].reverse())
            .sources[0].sourceId).toBe('character-hoshino')
    })

    test('reports added, updated, deleted and unchanged source IDs', () => {
        const previous = createNarrativeSourceSnapshot([
            {
                sourceId: 'deleted',
                kind: 'lorebook-entry',
                content: 'old',
            },
            {
                sourceId: 'updated',
                kind: 'lorebook-entry',
                content: 'before',
            },
            {
                sourceId: 'unchanged',
                kind: 'character-description',
                content: 'same',
            },
        ])
        const next = createNarrativeSourceSnapshot([
            {
                sourceId: 'unchanged',
                kind: 'character-description',
                content: 'same',
            },
            {
                sourceId: 'added',
                kind: 'lorebook-entry',
                content: 'new',
            },
            {
                sourceId: 'updated',
                kind: 'lorebook-entry',
                content: 'after',
            },
        ])

        expect(diffNarrativeSourceSnapshots(previous, next)).toEqual({
            added: ['added'],
            updated: ['updated'],
            deleted: ['deleted'],
            unchanged: ['unchanged'],
        })
    })

    test('treats a kind change as an update and ignores input order', () => {
        const previous = createNarrativeSourceSnapshot([
            {
                sourceId: 'a',
                kind: 'lorebook-entry',
                content: 'same',
            },
            {
                sourceId: 'b',
                kind: 'lorebook-entry',
                content: 'same',
            },
        ])
        const reordered = createNarrativeSourceSnapshot([
            {
                sourceId: 'b',
                kind: 'lorebook-entry',
                content: 'same',
            },
            {
                sourceId: 'a',
                kind: 'lorebook-entry',
                content: 'same',
            },
        ])
        expect(diffNarrativeSourceSnapshots(previous, reordered)).toEqual({
            added: [],
            updated: [],
            deleted: [],
            unchanged: ['a', 'b'],
        })

        const changedKind = createNarrativeSourceSnapshot([
            {
                sourceId: 'a',
                kind: 'character-description',
                content: 'same',
            },
            {
                sourceId: 'b',
                kind: 'lorebook-entry',
                content: 'same',
            },
        ])
        expect(diffNarrativeSourceSnapshots(previous, changedKind).updated)
            .toEqual(['a'])
    })

    test('orders source IDs without locale-dependent collation', () => {
        const snapshot = createNarrativeSourceSnapshot(
            ['ä', 'a', 'Z'].map((sourceId) => ({
                sourceId,
                kind: 'lorebook-entry',
                content: sourceId,
            }))
        )

        expect(snapshot.sources.map((source) => source.sourceId))
            .toEqual(['Z', 'a', 'ä'])
    })

    test.each([
        {
            name: 'duplicate IDs',
            value: [
                {
                    sourceId: 'same',
                    kind: 'lorebook-entry',
                    content: 'one',
                },
                {
                    sourceId: 'same',
                    kind: 'lorebook-entry',
                    content: 'two',
                },
            ],
        },
        {
            name: 'empty IDs',
            value: [{
                sourceId: ' ',
                kind: 'lorebook-entry',
                content: 'value',
            }],
        },
        {
            name: 'empty content',
            value: [{
                sourceId: 'source',
                kind: 'lorebook-entry',
                content: '',
            }],
        },
        {
            name: 'unsupported kinds',
            value: [{
                sourceId: 'source',
                kind: 'file',
                content: 'value',
            }],
        },
        {
            name: 'additional fields',
            value: [{
                sourceId: 'source',
                kind: 'lorebook-entry',
                content: 'value',
                path: '../lore.json',
            }],
        },
    ])('rejects $name', ({ value }) => {
        expect(() => createNarrativeSourceSnapshot(value)).toThrow()
    })

    test('rejects sparse arrays and tampered persisted fingerprints', () => {
        const sparse = Array(1)
        expect(() => createNarrativeSourceSnapshot(sparse)).toThrow()

        const snapshot = createNarrativeSourceSnapshot([{
            sourceId: 'source',
            kind: 'lorebook-entry',
            content: 'value',
        }])
        const stored = structuredClone(snapshot)
        stored.sources[0].fingerprint = '0000000000000000'

        expect(() => validateNarrativeSourceSnapshot(stored))
            .toThrow(/fingerprint/i)
    })
})
