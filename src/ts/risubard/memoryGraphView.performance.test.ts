import { describe, expect, test } from 'vitest'
import type {
    NarrativeGraphStateV2,
    NarrativeNode,
} from '../../../packages/risubard-core/src/narrativeGraph'
import { createNarrativeGraphProjection } from './memoryGraphView'

function graph(nodeCount: number): NarrativeGraphStateV2 {
    const nodes = Array.from({ length: nodeCount }, (_, index) => ({
        id: `entity:${String(index).padStart(5, '0')}`,
        kind: 'entity',
        subtype: 'character',
        title: `Character ${index}`,
        summary: `Character ${index} summary`,
        storyId: 'character',
        branchId: 'chat',
        status: 'active',
        authority: 'draft',
        salience: 5,
        perspective: { kind: 'omniscient' },
        epistemic: 'fact',
        evidence: [{ chatId: 'chat', messageId: 'message-1' }],
        revision: 1,
    })) as NarrativeNode[]
    return {
        schemaVersion: 2,
        storyId: 'character',
        branchId: 'chat',
        revision: 1,
        nodes,
        edges: Array.from({ length: 300 }, (_, index) => ({
            id: `edge:${String(index).padStart(4, '0')}`,
            sourceId: nodes[index % 96].id,
            type: 'involves',
            targetId: nodes[(index * 11 + 1) % 96].id,
            storyId: 'character',
            branchId: 'chat',
            evidence: [{ chatId: 'chat', messageId: 'message-1' }],
            revision: 1,
        })),
        appliedOperationIds: [],
    }
}

function p95(samples: number[]): number {
    const ordered = [...samples].sort((left, right) => left - right)
    return ordered[Math.floor((ordered.length - 1) * .95)]
}

describe('memory graph view performance bounds', () => {
    test('measures fixed render projection across 10x graph growth', () => {
        const measure = (state: NarrativeGraphStateV2) => {
            const samples = Array.from({ length: 40 }, () => {
                const started = performance.now()
                const projection = createNarrativeGraphProjection(state)
                const elapsed = performance.now() - started
                expect(projection.visibleNodes).toHaveLength(96)
                expect(projection.visibleEdges).toHaveLength(192)
                return elapsed
            })
            return p95(samples)
        }
        const baseline = graph(100)
        const grown = graph(1_000)
        const baselineP95Ms = measure(baseline)
        const grownP95Ms = measure(grown)

        console.info('[RisuBard memory graph view benchmark]', {
            baselineNodes: baseline.nodes.length,
            grownNodes: grown.nodes.length,
            visibleNodes: 96,
            visibleEdges: 192,
            baselineP95Ms,
            grownP95Ms,
        })
    })
})
