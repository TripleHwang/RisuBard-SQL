import { describe, expect, test } from 'vitest'
import { parseAutomaticWikiTargets } from './automaticWikiUpdate'

const documents = [{
    id: 'character.lavian',
    type: 'character' as const,
    title: '라비안',
}, {
    id: 'event.turn',
    type: 'event' as const,
    title: '전투',
}]

describe('automatic wiki update target selection', () => {
    test('accepts bounded existing updates and new canonical pages only', () => {
        expect(parseAutomaticWikiTargets([
            'UPDATE character.lavian',
            'UPDATE character.lavian',
            'UPDATE event.turn',
            'UPDATE missing.page',
            'CREATE location 케사리아',
            'CREATE invalid 무시',
        ].join('\n'), documents)).toEqual([{
            documentId: 'character.lavian',
            type: 'character',
            title: '라비안',
        }, {
            type: 'location',
            title: '케사리아',
        }])
    })

    test('treats NONE and malformed output as no canonical changes', () => {
        expect(parseAutomaticWikiTargets('NONE', documents)).toEqual([])
        expect(parseAutomaticWikiTargets('# 설명만 있음', documents)).toEqual([])
    })
})
