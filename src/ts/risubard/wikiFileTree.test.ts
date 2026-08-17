import { describe, expect, it } from 'vitest'
import { buildWikiFileTree } from './wikiFileTree'

describe('buildWikiFileTree', () => {
    it('shows the newest recorded event first regardless of hashed filename', () => {
        const tree = buildWikiFileTree([
            {
                id: 'event-new', title: '나중 사건',
                relativePath: 'events/turn-zzz.md', type: 'event',
                created: '2026-08-14T08:00:00.000Z',
            },
            {
                id: 'event-old', title: '이전 사건',
                relativePath: 'events/turn-aaa.md', type: 'event',
                created: '2026-08-14T07:00:00.000Z',
            },
        ])

        expect(tree.find((node) => node.name === 'events')).toEqual(
            expect.objectContaining({
                children: [
                    expect.objectContaining({ documentId: 'event-new' }),
                    expect.objectContaining({ documentId: 'event-old' }),
                ],
            })
        )
    })

    it('shows every standard wiki folder even when it has no documents', () => {
        const tree = buildWikiFileTree([])

        expect(tree.map((node) => node.name)).toEqual([
            'characters',
            'concepts',
            'events',
            'factions',
            'items',
            'locations',
            'notes',
        ])
        expect(tree.every((node) =>
            node.kind === 'folder' && node.children.length === 0
        )).toBe(true)
        expect(tree.find((node) => node.name === 'events')).toEqual(
            expect.objectContaining({ readOnly: true })
        )
    })

    it('groups documents by path and marks the events folder read-only', () => {
        const tree = buildWikiFileTree([
            { id: 'scene', title: '현재 장면', relativePath: 'current-scene.md', type: 'scene' },
            { id: 'character', title: '라비안', relativePath: 'characters/라비안.md', type: 'character' },
            { id: 'event', title: '전투', relativePath: 'events/turn-1.md', type: 'event' },
        ])

        expect(tree.map((node) => node.name)).toEqual([
            'current-scene.md',
            'characters',
            'concepts',
            'events',
            'factions',
            'items',
            'locations',
            'notes',
        ])
        expect(tree.find((node) => node.name === 'events')).toEqual(
            expect.objectContaining({
                kind: 'folder',
                readOnly: true,
                children: [expect.objectContaining({ documentId: 'event' })],
            })
        )
    })

    it('omits legacy retracted events from the file tree', () => {
        const tree = buildWikiFileTree([{
            id: 'event-retracted',
            title: '잘못된 첫 만남',
            relativePath: 'events/turn-retracted.md',
            type: 'event',
            status: 'retracted',
        }])

        expect(tree.find((node) => node.name === 'events')).toEqual(
            expect.objectContaining({
                kind: 'folder',
                readOnly: true,
                children: [],
            })
        )
    })
})
