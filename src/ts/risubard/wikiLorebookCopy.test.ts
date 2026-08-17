import { describe, expect, test } from 'vitest'
import type { loreBook } from '../storage/database.svelte'
import { copyWikiDocumentToLorebook } from './wikiLorebookCopy'

function lore(name: string, content = 'old'): loreBook {
    return {
        id: `id-${name}`,
        enabled: true,
        key: 'keyword',
        secondkey: 'secondary',
        insertorder: 42,
        comment: name,
        content,
        mode: 'normal',
        alwaysActive: true,
        selective: true,
        folder: 'folder-1',
    }
}

describe('BardWiki document lorebook copy', () => {
    test('creates a disabled entry with empty activation keys', () => {
        const original = [lore('Existing')]

        const result = copyWikiDocumentToLorebook(original, {
            title: '라비안',
            content: '# 라비안\n\n기사.',
        }, 'suffix', () => 'new-id')

        expect(result.action).toBe('created')
        expect(result.entry).toEqual(expect.objectContaining({
            id: 'new-id',
            comment: '라비안',
            content: '# 라비안\n\n기사.',
            enabled: false,
            alwaysActive: false,
            key: '',
            secondkey: '',
            selective: false,
            mode: 'normal',
        }))
        expect(original).toHaveLength(1)
        expect(result.lorebooks).toHaveLength(2)
    })

    test('overwrites the matching entry while preserving its identity and folder', () => {
        const original = [lore('라비안'), lore('Other')]

        const result = copyWikiDocumentToLorebook(original, {
            title: '라비안', content: 'new canonical text',
        }, 'overwrite', () => 'unused-id')

        expect(result.action).toBe('overwritten')
        expect(result.entry).toEqual(expect.objectContaining({
            id: 'id-라비안',
            folder: 'folder-1',
            comment: '라비안',
            content: 'new canonical text',
            enabled: false,
            alwaysActive: false,
            key: '',
            secondkey: '',
        }))
        expect(result.lorebooks[1]).toBe(original[1])
        expect(original[0].content).toBe('old')
    })

    test('uses the first free numeric suffix instead of overwriting', () => {
        const original = [lore('라비안'), lore('라비안-2'), lore('라비안-4')]

        const result = copyWikiDocumentToLorebook(original, {
            title: '라비안', content: 'copy',
        }, 'suffix', () => 'new-id')

        expect(result.entry.comment).toBe('라비안-3')
        expect(result.action).toBe('created')
    })
})
