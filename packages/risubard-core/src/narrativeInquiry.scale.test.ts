import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import {
    createNarrativeSourcesPrompt,
} from '../../../src/ts/risubard/narrativeContext'
import type { NarrativeGraphStateV2, NarrativeNode } from './narrativeGraph'
import { buildNarrativeIndex } from './narrativeIndex'
import {
    inquireNarrativeMemory,
    narrativeInquiryToContextSources,
} from './narrativeInquiry'

function graphWithUnrelatedNodes(nodeCount: number): NarrativeGraphStateV2 {
    const evidence = [{ chatId: 'chat', messageId: 'message' }]
    const relevant: NarrativeNode = {
        id: 'event:bridge',
        kind: 'event',
        subtype: 'event',
        title: 'Bridge collapse',
        summary: 'The bridge collapsed during the escape.',
        storyId: 'character',
        branchId: 'chat',
        status: 'active',
        authority: 'draft',
        salience: 10,
        perspective: { kind: 'omniscient' },
        epistemic: 'fact',
        evidence,
        revision: 1,
    }
    return {
        schemaVersion: 2,
        storyId: 'character',
        branchId: 'chat',
        revision: 1,
        nodes: [
            relevant,
            ...Array.from({ length: nodeCount - 1 }, (_, index) => ({
                ...relevant,
                id: `event:unrelated-${index}`,
                title: `Unrelated ${index}`,
                summary: `Unrelated unique memory ${index}`,
                salience: 1,
            })),
        ],
        edges: [],
        appliedOperationIds: [],
    }
}

function p95(samples: number[]): number {
    const sorted = [...samples].sort((left, right) => left - right)
    return sorted[Math.ceil(sorted.length * 0.95) - 1]
}

describe('1k/10k narrative inquiry scale bounds', () => {
    it('keeps retrieval work and provider prompt bytes invariant', () => {
        const measurements = [1_000, 10_000].map((nodeCount) => {
            const graph = graphWithUnrelatedNodes(nodeCount)
            const coldSamples: number[] = []
            let index = buildNarrativeIndex(graph)
            for (let sample = 0; sample < 10; sample += 1) {
                const started = performance.now()
                index = buildNarrativeIndex(graph)
                coldSamples.push(performance.now() - started)
            }
            const input = {
                entityIds: [],
                openThreadIds: [],
                terms: ['bridge', 'collapse'],
                perspectiveEntityIds: [],
                tokenBudget: 512,
                maxSelectedNodes: 16,
            } as const
            const warmSamples = Array.from({ length: 300 }, () => {
                const started = performance.now()
                inquireNarrativeMemory(index, input)
                return performance.now() - started
            })
            const result = inquireNarrativeMemory(index, input)
            const prompt = createNarrativeSourcesPrompt(
                narrativeInquiryToContextSources(result)
            ) ?? ''
            return {
                nodeCount,
                candidateCount: result.metrics.candidateCount,
                inspectedNodeCount: result.metrics.inspectedNodeCount,
                inspectedEdgeCount: result.metrics.inspectedEdgeCount,
                selectedNodeCount: result.metrics.selectedNodeCount,
                selectedTokens: result.metrics.selectedTokens,
                promptBytes: Buffer.byteLength(prompt, 'utf8'),
                warmP95Ms: p95(warmSamples),
                indexBuildP95Ms: p95(coldSamples),
            }
        })

        console.info('[RisuBard 1k/10k inquiry]', measurements)
        expect(measurements[1]).toMatchObject({
            candidateCount: measurements[0].candidateCount,
            inspectedNodeCount: measurements[0].inspectedNodeCount,
            inspectedEdgeCount: measurements[0].inspectedEdgeCount,
            selectedNodeCount: measurements[0].selectedNodeCount,
            selectedTokens: measurements[0].selectedTokens,
            promptBytes: measurements[0].promptBytes,
        })
        expect(measurements.every((item) =>
            item.candidateCount <= 64
            && item.inspectedNodeCount <= 64
            && item.selectedNodeCount <= 16
            && item.selectedTokens <= 512
        )).toBe(true)
    })
})
