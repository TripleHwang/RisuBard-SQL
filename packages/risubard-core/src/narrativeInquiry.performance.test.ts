import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { NarrativeNode } from './narrativeGraph'
import { createLinaKainGraph } from './narrativeGraphFixture'
import { buildNarrativeIndex } from './narrativeIndex'
import { inquireNarrativeMemory } from './narrativeInquiry'

function expandedGraph() {
    const graph = createLinaKainGraph()
    const initialCount = graph.nodes.length
    graph.nodes.push(...Array.from(
        { length: initialCount * 9 },
        (_, index): NarrativeNode => ({
            id: `event:performance-noise-${index}`,
            kind: 'event',
            subtype: 'event',
            title: `성능 잡음 ${index}`,
            summary: `현재 inquiry와 무관한 고유 사건 performance-${index}`,
            storyId: graph.storyId,
            branchId: graph.branchId,
            status: 'active',
            authority: 'draft',
            salience: 1,
            occurredAt: 100 + index,
            perspective: { kind: 'omniscient' },
            epistemic: 'fact',
            evidence: [{
                chatId: 'performance-chat',
                messageId: `performance-message-${index}`,
            }],
            revision: 1,
        })
    ))
    return graph
}

function p95(samples: number[]): number {
    const sorted = [...samples].sort((left, right) => left - right)
    return sorted[Math.ceil(sorted.length * 0.95) - 1]
}

describe('narrative inquiry performance bounds', () => {
    it('measures bounded warm and cold retrieval on the 10x graph', () => {
        const graph = expandedGraph()
        const input = {
            entityIds: ['entity:lina', 'entity:kain'],
            openThreadIds: ['thread:broken-rendezvous'],
            terms: ['믿는다'],
            perspectiveEntityIds: ['entity:lina', 'entity:kain'],
            excludeUnmarkedOmniscientClaims: true,
            tokenBudget: 220,
            maxSelectedNodes: 8,
        } as const
        const index = buildNarrativeIndex(graph)
        const warmSamples = Array.from({ length: 500 }, () => {
            const started = performance.now()
            inquireNarrativeMemory(index, input)
            return performance.now() - started
        })
        const coldSamples = Array.from({ length: 100 }, () => {
            const started = performance.now()
            inquireNarrativeMemory(buildNarrativeIndex(graph), input)
            return performance.now() - started
        })
        const result = inquireNarrativeMemory(index, input)
        const measurement = {
            nodeCount: graph.nodes.length,
            candidateCount: result.metrics.candidateCount,
            inspectedNodeCount: result.metrics.inspectedNodeCount,
            inspectedEdgeCount: result.metrics.inspectedEdgeCount,
            selectedTokens: result.metrics.selectedTokens,
            hopCount: result.metrics.hopCount,
            warmP95Ms: p95(warmSamples),
            coldP95Ms: p95(coldSamples),
        }

        console.info('[RisuBard narrative inquiry benchmark]', measurement)
        expect(measurement.nodeCount).toBe(100)
        expect(measurement.candidateCount).toBeLessThanOrEqual(64)
        expect(measurement.hopCount).toBe(1)
        expect(measurement.selectedTokens).toBeLessThanOrEqual(220)
        expect(measurement.warmP95Ms).toBeLessThan(25)
        expect(measurement.coldP95Ms).toBeLessThan(150)
    })
})
