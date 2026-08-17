import { describe, expect, test } from 'vitest'
import type {
    NarrativeGraphStateV2,
    NarrativeNode,
} from '../../../packages/risubard-core/src/narrativeGraph'
import { createNarrativeGraphProjection } from './memoryGraphView'

function node(
    id: string,
    kind: NarrativeNode['kind'],
    title: string,
    salience = 5
): NarrativeNode {
    return {
        id,
        kind,
        subtype: kind === 'claim' ? 'belief' : kind === 'entity'
            ? 'character'
            : undefined,
        title,
        summary: `${title} summary`,
        storyId: 'character',
        branchId: 'chat',
        status: 'active',
        authority: 'draft',
        salience,
        perspective: kind === 'claim'
            ? { kind: 'character', entityId: 'entity:lina' }
            : { kind: 'omniscient' },
        epistemic: kind === 'claim' ? 'belief' : 'fact',
        evidence: [{ chatId: 'chat', messageId: 'message-1' }],
        revision: 1,
    } as NarrativeNode
}

function graph(): NarrativeGraphStateV2 {
    return {
        schemaVersion: 2,
        storyId: 'character',
        branchId: 'chat',
        revision: 1,
        nodes: [
            node('entity:lina', 'entity', 'Lina', 8),
            node('claim:secret', 'claim', 'The hidden oath', 7),
            node('event:arrival', 'event', 'Arrival', 6),
        ],
        edges: [{
            id: 'edge:belief-holder',
            sourceId: 'claim:secret',
            type: 'believed_by',
            targetId: 'entity:lina',
            storyId: 'character',
            branchId: 'chat',
            evidence: [{ chatId: 'chat', messageId: 'message-1' }],
            revision: 1,
        }],
        appliedOperationIds: [],
    }
}

describe('createNarrativeGraphProjection', () => {
    test('filters nodes before producing a deterministic bounded layout', () => {
        const state = graph()
        const original = structuredClone(state)

        const projection = createNarrativeGraphProjection(state, {
            query: 'hidden',
            kind: 'claim',
            status: 'active',
        })

        expect(projection).toMatchObject({
            totalNodeCount: 3,
            matchingNodeCount: 1,
            truncated: false,
            visibleEdges: [],
        })
        expect(projection.visibleNodes).toEqual([
            expect.objectContaining({
                id: 'claim:secret',
                x: 50,
                y: 50,
            }),
        ])
        expect(state).toEqual(original)
    })

    test('keeps rendered node and edge work fixed as the graph grows 10x', () => {
        const createGraph = (nodeCount: number): NarrativeGraphStateV2 => {
            const nodes = Array.from({ length: nodeCount }, (_, index) =>
                node(
                    `entity:${String(index).padStart(4, '0')}`,
                    'entity',
                    `Character ${index}`
                )
            )
            const edges = Array.from({ length: 300 }, (_, index) => ({
                id: `edge:${String(index).padStart(4, '0')}`,
                sourceId: nodes[index % 96].id,
                type: 'about' as const,
                targetId: nodes[(index * 7 + 1) % 96].id,
                storyId: 'character',
                branchId: 'chat',
                evidence: [{ chatId: 'chat', messageId: 'message-1' }],
                revision: 1,
            }))
            return {
                schemaVersion: 2,
                storyId: 'character',
                branchId: 'chat',
                revision: 1,
                nodes,
                edges,
                appliedOperationIds: [],
            }
        }

        const baseline = createNarrativeGraphProjection(createGraph(100))
        const grown = createNarrativeGraphProjection(createGraph(1_000))

        expect({
            nodes: baseline.visibleNodes.length,
            edges: baseline.visibleEdges.length,
        }).toEqual({ nodes: 96, edges: 192 })
        expect({
            nodes: grown.visibleNodes.length,
            edges: grown.visibleEdges.length,
        }).toEqual({ nodes: 96, edges: 192 })
        expect(grown.truncated).toBe(true)
    })

    test('splits dense kinds into lanes of at most six non-overlapping rows', () => {
        const state = graph()
        state.nodes = Array.from({ length: 96 }, (_, index) =>
            node(`entity:${String(index).padStart(3, '0')}`, 'entity', `${index}`)
        )
        state.edges = []

        const projection = createNarrativeGraphProjection(state)
        const nodesByX = new Map<number, number>()
        for (const item of projection.visibleNodes) {
            nodesByX.set(item.x, (nodesByX.get(item.x) ?? 0) + 1)
        }

        expect(projection.laneCount).toBe(16)
        expect(Math.max(...nodesByX.values())).toBeLessThanOrEqual(6)
    })

    test('keeps every node center inside a card-safe canvas margin', () => {
        const state = graph()
        state.nodes = [
            node('entity:1', 'entity', 'Entity 1'),
            node('entity:2', 'entity', 'Entity 2'),
            node('event:1', 'event', 'Event 1'),
            node('event:2', 'event', 'Event 2'),
        ]
        state.edges = []

        const projection = createNarrativeGraphProjection(state)

        for (const item of projection.visibleNodes) {
            expect(item.x).toBeGreaterThanOrEqual(12)
            expect(item.x).toBeLessThanOrEqual(88)
            expect(item.y).toBeGreaterThanOrEqual(12)
            expect(item.y).toBeLessThanOrEqual(88)
        }
    })
})
