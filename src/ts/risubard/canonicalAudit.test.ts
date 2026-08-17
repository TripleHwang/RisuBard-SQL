import { describe, expect, test } from 'vitest'
import { collectCanonicalAudit } from './canonicalAudit'

const event = {
    id: 'event.turn-1', type: 'event', status: 'active', title: '도착',
    relativePath: 'events/turn-1.md', sourceMessageIds: ['assistant-1'],
    updated: '2026-08-11T00:00:00Z', links: [], contextMode: 'auto',
    contentHash: 'event-hash',
    content: '# 도착\n\n## 정본 갱신 후보\n\n- character [[라비안]]: 위치가 변했다.',
} as const

describe('canonical audit projection', () => {
    test('reports an event candidate until a matching canonical includes its evidence', () => {
        expect(collectCanonicalAudit([event])).toMatchObject({
            attentionCount: 1,
            unresolvedCandidates: [{
                type: 'character', title: '라비안',
                reason: '위치가 변했다.', conflict: false,
            }],
        })
        expect(collectCanonicalAudit([event, {
            ...event, id: 'character.lavian', type: 'character',
            title: '라비안',
            relativePath: 'characters/lavian.md', content: '# 라비안',
            contentHash: 'canonical-hash', reviewStatus: 'unreviewed',
        }])).toMatchObject({
            attentionCount: 1,
            unresolvedCandidates: [],
            unreviewedCount: 1,
        })
    })

    test('marks duplicate title targets as a conflict', () => {
        const duplicate = (id: string) => ({
            ...event, id, type: 'character' as const,
            title: '라비안',
            relativePath: `characters/${id}.md`, content: '# 라비안',
            contentHash: id, sourceMessageIds: [],
        })
        expect(collectCanonicalAudit([
            event, duplicate('character.1'), duplicate('character.2'),
        ]).unresolvedCandidates[0]).toMatchObject({ conflict: true })
    })
})
