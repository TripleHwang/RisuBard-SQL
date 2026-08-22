import { describe, expect, it } from 'vitest'
import {
    assignCollectionItem,
    assignItemsToFolder,
    createCollectionFolder,
    deleteCollectionFolder,
    filterCollectionItems,
    normalizeCollectionOrganizerState,
    renameCollectionFolder,
    reorderVisibleCollectionItems,
} from './collectionOrganizer'

describe('collection organizer state', () => {
    it('normalizes duplicate and invalid folders without mutating the saved state', () => {
        const saved = {
            folders: [
                { id: 'work', name: 'Work' },
                { id: 'work', name: 'Duplicate' },
                { id: '', name: 'Missing id' },
                { id: 'blank', name: '  ' },
            ],
            folderByItemId: { a: 'work', b: 'gone', stale: 'work' },
            itemOrder: ['b', 'a', 'a', 'stale'],
        }

        expect(normalizeCollectionOrganizerState(saved, ['a', 'b', 'c'])).toEqual({
            folders: [{ id: 'work', name: 'Work' }],
            folderByItemId: { a: 'work' },
            itemOrder: ['b', 'a', 'c'],
        })
        expect(saved).toEqual({
            folders: [
                { id: 'work', name: 'Work' },
                { id: 'work', name: 'Duplicate' },
                { id: '', name: 'Missing id' },
                { id: 'blank', name: '  ' },
            ],
            folderByItemId: { a: 'work', b: 'gone', stale: 'work' },
            itemOrder: ['b', 'a', 'a', 'stale'],
        })
    })

    it('keeps saved item order and appends new items stably', () => {
        expect(normalizeCollectionOrganizerState({ itemOrder: ['c', 'a'] }, ['a', 'b', 'c', 'd']).itemOrder)
            .toEqual(['c', 'a', 'b', 'd'])
    })

    it('shows unassigned items when filtering for uncategorized', () => {
        const state = normalizeCollectionOrganizerState({
            folders: [{ id: 'work', name: 'Work' }],
            folderByItemId: { a: 'work' },
            itemOrder: ['a', 'b', 'c'],
        }, ['a', 'b', 'c'])

        expect(filterCollectionItems(state, null)).toEqual(['b', 'c'])
        expect(filterCollectionItems(state, 'work')).toEqual(['a'])
    })

    it('deletes a folder and unassigns its items', () => {
        const state = normalizeCollectionOrganizerState({
            folders: [{ id: 'work', name: 'Work' }],
            folderByItemId: { a: 'work', b: 'work' },
            itemOrder: ['a', 'b'],
        }, ['a', 'b'])

        expect(deleteCollectionFolder(state, 'work')).toEqual({
            folders: [],
            folderByItemId: {},
            itemOrder: ['a', 'b'],
        })
    })

    it('assigns and unassigns one current item', () => {
        const state = normalizeCollectionOrganizerState({
            folders: [{ id: 'work', name: 'Work' }],
            itemOrder: ['a'],
        }, ['a'])

        expect(assignCollectionItem(assignCollectionItem(state, 'a', 'work'), 'a', null))
            .toEqual(state)
    })

    it('renames an existing folder with a trimmed name', () => {
        const state = normalizeCollectionOrganizerState({
            folders: [{ id: 'work', name: 'Work' }],
        }, [])

        expect(renameCollectionFolder(state, 'work', '  Writing  ').folders)
            .toEqual([{ id: 'work', name: 'Writing' }])
    })

    it('reorders a filtered subset while preserving hidden item slots', () => {
        const state = normalizeCollectionOrganizerState({
            folders: [{ id: 'work', name: 'Work' }],
            folderByItemId: { a: 'work', c: 'work' },
            itemOrder: ['a', 'b', 'c', 'd'],
        }, ['a', 'b', 'c', 'd'])

        expect(reorderVisibleCollectionItems(state, ['c', 'a'])).toEqual({
            ...state,
            itemOrder: ['c', 'b', 'a', 'd'],
        })
    })

    it('bulk assigns items and creates folders with caller-provided ids', () => {
        const state = normalizeCollectionOrganizerState({ itemOrder: ['a', 'b', 'c'] }, ['a', 'b', 'c'])
        const withFolder = createCollectionFolder(state, 'Work', 'folder-1')

        expect(assignItemsToFolder(withFolder, ['a', 'c', 'missing'], 'folder-1')).toEqual({
            folders: [{ id: 'folder-1', name: 'Work' }],
            folderByItemId: { a: 'folder-1', c: 'folder-1' },
            itemOrder: ['a', 'b', 'c'],
        })
    })
})
