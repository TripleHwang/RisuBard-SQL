import { describe, expect, test } from 'vitest'
import { diffNarrativeSourceSnapshots } from '../../../packages/risubard-core/src/sourceSnapshot'
import { projectLegacyNarrativeSources } from './sourceProjection'

describe('legacy narrative source projection', () => {
    test('projects description and selected lore without changing legacy data', () => {
        const input = {
            characterId: 'hoshino',
            description: '호시노는 20세 인간 여성이다.',
            loreGroups: [
                {
                    scopeId: 'character',
                    entries: [
                        {
                            id: 'weapons',
                            key: '호시노',
                            comment: '장비',
                            content: '단검 두 자루와 흰색 샷건을 사용한다.',
                            mode: 'normal',
                            alwaysActive: true,
                        },
                        {
                            id: 'folder',
                            content: '',
                            mode: 'folder',
                        },
                    ],
                },
                {
                    scopeId: 'chat:chat-1',
                    entries: [
                        {
                            id: 'empty',
                            content: '   ',
                            mode: 'normal',
                        },
                    ],
                },
            ],
        }
        const before = structuredClone(input)

        const snapshot = projectLegacyNarrativeSources(input)

        expect(snapshot.sources).toEqual([
            {
                sourceId: 'character-description:hoshino',
                kind: 'character-description',
                content: '호시노는 20세 인간 여성이다.',
                fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
            },
            {
                sourceId: 'lorebook:character:id:weapons',
                kind: 'lorebook-entry',
                content: '단검 두 자루와 흰색 샷건을 사용한다.',
                fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/),
            },
        ])
        expect(input).toEqual(before)
    })

    test('keeps legacy fallback IDs stable across reorder and distinguishes duplicates', () => {
        const first = {
            characterId: 'character',
            description: '',
            loreGroups: [{
                scopeId: 'character',
                entries: [
                    {
                        key: 'a',
                        comment: 'A',
                        content: 'alpha',
                        mode: 'normal',
                    },
                    {
                        key: 'b',
                        comment: 'B',
                        content: 'beta',
                        mode: 'constant',
                    },
                    {
                        key: 'a',
                        comment: 'A',
                        content: 'alpha',
                        mode: 'normal',
                    },
                ],
            }],
        }
        const reordered = {
            ...first,
            loreGroups: [{
                ...first.loreGroups[0],
                entries: [
                    first.loreGroups[0].entries[2],
                    first.loreGroups[0].entries[1],
                    first.loreGroups[0].entries[0],
                ],
            }],
        }

        const firstSnapshot = projectLegacyNarrativeSources(first)
        const reorderedSnapshot = projectLegacyNarrativeSources(reordered)

        expect(reorderedSnapshot).toEqual(firstSnapshot)
        expect(firstSnapshot.sources).toHaveLength(3)
        expect(new Set(firstSnapshot.sources.map((source) => source.sourceId))
            .size).toBe(3)
        expect(firstSnapshot.sources.every((source) =>
            source.sourceId.includes(':legacy:')
        )).toBe(true)
    })

    test('reports explicit-ID content edits as updates', () => {
        const before = projectLegacyNarrativeSources({
            characterId: 'character',
            description: '',
            loreGroups: [{
                scopeId: 'module:weather',
                entries: [{
                    id: 'sky',
                    content: '하늘은 맑다.',
                    mode: 'normal',
                }],
            }],
        })
        const after = projectLegacyNarrativeSources({
            characterId: 'character',
            description: '',
            loreGroups: [{
                scopeId: 'module:weather',
                entries: [{
                    id: 'sky',
                    content: '하늘에는 폭풍이 몰아친다.',
                    mode: 'normal',
                }],
            }],
        })

        expect(diffNarrativeSourceSnapshots(before, after)).toEqual({
            added: [],
            updated: ['lorebook:module%3Aweather:id:sky'],
            deleted: [],
            unchanged: [],
        })
    })

    test('keeps scopes separate when legacy lore IDs are reused', () => {
        const snapshot = projectLegacyNarrativeSources({
            characterId: 'character',
            description: '',
            loreGroups: [
                {
                    scopeId: 'character',
                    entries: [{
                        id: 'shared',
                        content: 'character lore',
                        mode: 'normal',
                    }],
                },
                {
                    scopeId: 'chat:chat-1',
                    entries: [{
                        id: 'shared',
                        content: 'chat lore',
                        mode: 'normal',
                    }],
                },
            ],
        })

        expect(snapshot.sources.map((source) => source.sourceId)).toEqual([
            'lorebook:character:id:shared',
            'lorebook:chat%3Achat-1:id:shared',
        ])
    })

    test.each([
        {
            name: 'empty character IDs',
            input: {
                characterId: ' ',
                description: 'value',
                loreGroups: [],
            },
        },
        {
            name: 'empty scope IDs',
            input: {
                characterId: 'character',
                description: 'value',
                loreGroups: [{ scopeId: '', entries: [] }],
            },
        },
        {
            name: 'sparse lore arrays',
            input: {
                characterId: 'character',
                description: 'value',
                loreGroups: [{
                    scopeId: 'character',
                    entries: Array(1),
                }],
            },
        },
    ])('rejects $name', ({ input }) => {
        expect(() => projectLegacyNarrativeSources(input)).toThrow()
    })
})
