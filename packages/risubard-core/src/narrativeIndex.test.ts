import { describe, expect, it, vi } from 'vitest'
import type { NarrativeEdge, NarrativeNode } from './narrativeGraph'
import { createLinaKainGraph } from './narrativeGraphFixture'
import {
    buildNarrativeIndex,
    normalizeNarrativeTerms,
    updateNarrativeIndex,
} from './narrativeIndex'
import {
    applyNarrativeGraphDelta,
    type NarrativeGraphDeltaV2,
} from './narrativeDelta'

describe('buildNarrativeIndex', () => {
    it('builds deterministic lookup, postings, adjacency and hot lists', () => {
        const graph = createLinaKainGraph()
        const index = buildNarrativeIndex(graph)

        expect(index.revision).toBe(1)
        expect(Object.keys(index.nodeById)).toEqual(
            [...Object.keys(index.nodeById)].sort()
        )
        expect(index.postingsByEntity['entity:lina']).toEqual([
            'claim:lina-believes-betrayal',
            'entity:lina',
            'event:forged-letter-found',
            'event:gate-promise',
            'state:lina-kain-trust',
            'thread:broken-rendezvous',
        ])
        expect(index.postingsByTerm['불신한다']).toEqual([
            'state:lina-kain-trust',
        ])
        expect(index.edgesByNode['state:lina-kain-trust'].map(
            (edge) => edge.id
        )).toEqual([
            'edge:belief-trust',
            'edge:trust-kain',
            'edge:trust-lina',
        ])
        expect(index.activeStatesBySubject['entity:kain']).toEqual([
            'state:lina-kain-trust',
        ])
        expect(index.openThreadsByEntity['entity:lina']).toEqual([
            'thread:broken-rendezvous',
        ])
        expect(index.renderedCompactNode['claim:lina-believes-betrayal'])
            .toContain('[Belief — entity:lina]')
        expect(index.estimatedTokensByNode['claim:lina-believes-betrayal'])
            .toBeGreaterThan(0)
    })

    it('does not mutate input and is stable across node and edge order', () => {
        const graph = createLinaKainGraph()
        const original = structuredClone(graph)
        const reordered = structuredClone(graph)
        reordered.nodes.reverse()
        reordered.edges.reverse()

        expect(buildNarrativeIndex(reordered)).toEqual(
            buildNarrativeIndex(graph)
        )
        expect(graph).toEqual(original)
    })

    it('indexes IDs that overlap JavaScript object prototype names safely', () => {
        const graph = createLinaKainGraph()
        graph.nodes[0].id = '__proto__'
        for (const edge of graph.edges) {
            if (edge.sourceId === 'entity:lina') edge.sourceId = '__proto__'
            if (edge.targetId === 'entity:lina') edge.targetId = '__proto__'
        }
        for (const node of graph.nodes) {
            if (node.perspective.kind === 'character'
                && node.perspective.entityId === 'entity:lina') {
                node.perspective.entityId = '__proto__'
            }
        }

        const index = buildNarrativeIndex(graph)

        expect(index.nodeById['__proto__'].id).toBe('__proto__')
        expect(Array.isArray(index.edgesByNode['__proto__'])).toBe(true)
        expect(Object.getPrototypeOf(index.postingsByTerm)).toBeNull()
        expect(index.postingsByTerm['constructor']).toBeUndefined()
    })

    it('caps posting lists while retaining salient current nodes', () => {
        const graph = createLinaKainGraph()
        graph.nodes.push(...Array.from({ length: 40 }, (_, index):
        NarrativeNode => ({
            id: `event:lina-noise-${index}`,
            kind: 'event',
            subtype: 'event',
            title: `리나 잡음 ${index}`,
            summary: `리나와 연결됐지만 중요하지 않은 사건 ${index}`,
            storyId: graph.storyId,
            branchId: graph.branchId,
            status: 'active',
            authority: 'draft',
            salience: 0,
            occurredAt: 100 + index,
            perspective: { kind: 'omniscient' },
            epistemic: 'fact',
            evidence: [{
                chatId: 'noise-chat',
                messageId: `noise-${index}`,
            }],
            revision: 1,
        })))
        graph.edges.push(...Array.from({ length: 40 }, (_, index):
        NarrativeEdge => ({
            id: `edge:lina-noise-${index}`,
            sourceId: `event:lina-noise-${index}`,
            type: 'involves',
            targetId: 'entity:lina',
            storyId: graph.storyId,
            branchId: graph.branchId,
            evidence: [{
                chatId: 'noise-chat',
                messageId: `noise-${index}`,
            }],
            revision: 1,
        })))

        const index = buildNarrativeIndex(graph)

        expect(index.postingsByEntity['entity:lina']).toHaveLength(16)
        expect(index.postingsByEntity['entity:lina']).toContain(
            'state:lina-kain-trust'
        )
        expect(index.postingsByEntity['entity:lina']).toContain(
            'thread:broken-rendezvous'
        )
        expect(Math.max(...Object.values(index.postingsByTerm).map(
            (posting) => posting.length
        ))).toBeLessThanOrEqual(16)
    })
})

describe('normalizeNarrativeTerms', () => {
    it('normalizes Unicode terms deterministically and removes duplicates', () => {
        expect(normalizeNarrativeTerms('  리나, KAIN! 리나  ')).toEqual([
            'kain',
            '리나',
        ])
    })

    it('does not depend on host locale casing or collation', () => {
        const lower = vi.spyOn(String.prototype, 'toLocaleLowerCase')
            .mockReturnValue('locale-dependent')
        const compare = vi.spyOn(String.prototype, 'localeCompare')
            .mockImplementation(() => {
                throw new Error('host collation used')
            })
        let terms: string[] = []
        let nodeIds: string[] = []
        try {
            terms = normalizeNarrativeTerms('I')
            nodeIds = Object.keys(
                buildNarrativeIndex(createLinaKainGraph()).nodeById
            )
        }
        finally {
            lower.mockRestore()
            compare.mockRestore()
        }

        expect(terms).toEqual(['i'])
        expect(nodeIds).toEqual([...nodeIds].sort())
    })
})

describe('updateNarrativeIndex', () => {
    it('matches a full rebuild for bounded native v2 operations without mutating inputs', () => {
        const previous = createLinaKainGraph()
        const previousIndex = buildNarrativeIndex(previous)
        const evidence = [{
            chatId: previous.branchId,
            messageId: 'message-incremental',
        }]
        const delta: NarrativeGraphDeltaV2 = {
            schemaVersion: 2,
            storyId: previous.storyId,
            branchId: previous.branchId,
            operations: [{
                type: 'add-node',
                operationId: 'operation:add:incremental-event',
                node: {
                    id: 'event:incremental',
                    kind: 'event',
                    subtype: 'event',
                    title: '리나가 오래된 열쇠를 찾았다',
                    summary: '리나가 북문 근처에서 오래된 열쇠를 찾았다.',
                    storyId: previous.storyId,
                    branchId: previous.branchId,
                    status: 'active',
                    authority: 'draft',
                    salience: 8,
                    perspective: { kind: 'omniscient' },
                    epistemic: 'fact',
                    evidence,
                },
            }, {
                type: 'add-edge',
                operationId: 'operation:edge:incremental-event',
                edge: {
                    id: 'edge:incremental-lina',
                    sourceId: 'event:incremental',
                    type: 'involves',
                    targetId: 'entity:lina',
                    storyId: previous.storyId,
                    branchId: previous.branchId,
                    evidence,
                },
            }, {
                type: 'update-node-status',
                operationId: 'operation:invalidate:trust',
                nodeId: 'state:lina-kain-trust',
                status: 'superseded',
                evidence,
            }],
        }
        const next = applyNarrativeGraphDelta(previous, delta, evidence)
        const originalState = structuredClone(previous)
        const originalIndex = structuredClone(previousIndex)

        const updated = updateNarrativeIndex(
            previousIndex,
            previous,
            next,
            delta.operations
        )

        expect(updated).toEqual(buildNarrativeIndex(next))
        expect(JSON.stringify(updated)).toBe(
            JSON.stringify(buildNarrativeIndex(next))
        )
        expect(previous).toEqual(originalState)
        expect(previousIndex).toEqual(originalIndex)
    })

    it('refills a capped posting after a selected node is invalidated', () => {
        const previous = createLinaKainGraph()
        previous.nodes.push(...Array.from({ length: 24 }, (_, index):
        NarrativeNode => ({
            id: `event:shared-${index.toString().padStart(2, '0')}`,
            kind: 'event',
            subtype: 'event',
            title: '공통 단서',
            summary: `공통 단서 ${index}`,
            storyId: previous.storyId,
            branchId: previous.branchId,
            status: 'active',
            authority: 'draft',
            salience: 24 - index,
            occurredAt: index,
            perspective: { kind: 'omniscient' },
            epistemic: 'fact',
            evidence: [{
                chatId: previous.branchId,
                messageId: `shared-${index}`,
            }],
            revision: 1,
        })))
        const previousIndex = buildNarrativeIndex(previous)
        const selected = previousIndex.postingsByTerm['공통'][0]
        const evidence = [{
            chatId: previous.branchId,
            messageId: 'invalidate-shared',
        }]
        const delta: NarrativeGraphDeltaV2 = {
            schemaVersion: 2,
            storyId: previous.storyId,
            branchId: previous.branchId,
            operations: [{
                type: 'update-node-status',
                operationId: 'operation:invalidate:shared',
                nodeId: selected,
                status: 'invalidated',
                evidence,
            }],
        }
        const next = applyNarrativeGraphDelta(previous, delta, evidence)

        const updated = updateNarrativeIndex(
            previousIndex,
            previous,
            next,
            delta.operations
        )

        expect(updated.postingsByTerm['공통']).toHaveLength(16)
        expect(updated).toEqual(buildNarrativeIndex(next))
    })
})
