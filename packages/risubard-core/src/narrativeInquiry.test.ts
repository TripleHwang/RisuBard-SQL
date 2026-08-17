import { describe, expect, it } from 'vitest'
import { compileContext } from './contextCompiler'
import type { NarrativeNode } from './narrativeGraph'
import { createLinaKainGraph } from './narrativeGraphFixture'
import { buildNarrativeIndex } from './narrativeIndex'
import {
    inquireNarrativeMemory,
    narrativeInquiryToContextSources,
} from './narrativeInquiry'

function inquire(graph = createLinaKainGraph()) {
    return inquireNarrativeMemory(buildNarrativeIndex(graph), {
        entityIds: ['entity:lina', 'entity:kain'],
        openThreadIds: ['thread:broken-rendezvous'],
        terms: ['믿는다'],
        perspectiveEntityIds: ['entity:lina', 'entity:kain'],
        excludeUnmarkedOmniscientClaims: true,
        tokenBudget: 220,
        maxSelectedNodes: 8,
    })
}

describe('inquireNarrativeMemory', () => {
    it('selects the Lina/Kain relationship, belief, promise and ambush', () => {
        const result = inquire()
        const selectedIds = result.selected.map((item) => item.node.id)

        expect(selectedIds).toEqual(expect.arrayContaining([
            'state:lina-kain-trust',
            'claim:lina-believes-betrayal',
            'thread:broken-rendezvous',
            'event:gate-promise',
            'event:kain-ambushed',
            'event:forged-letter-found',
        ]))
        expect(selectedIds).not.toContain('event:unrelated-childhood')
        expect(selectedIds).not.toContain('claim:letter-was-forged')
        expect(result.metrics).toMatchObject({
            hopCount: 1,
            auxiliaryModelCalls: 0,
        })
        expect(result.metrics.candidateCount).toBeLessThanOrEqual(64)
        expect(result.metrics.inspectedNodeCount).toBeLessThanOrEqual(64)
        expect(result.metrics.inspectedEdgeCount).toBeLessThanOrEqual(
            result.metrics.inspectedNodeCount * 16
        )
        expect(result.metrics.selectedTokens).toBeLessThanOrEqual(220)
    })

    it('respects kind quotas and a fixed token budget deterministically', () => {
        const index = buildNarrativeIndex(createLinaKainGraph())
        const input = {
            entityIds: ['entity:lina', 'entity:kain'],
            openThreadIds: ['thread:broken-rendezvous'],
            terms: ['믿는다'],
            perspectiveEntityIds: ['entity:lina', 'entity:kain'],
            excludeUnmarkedOmniscientClaims: true,
            tokenBudget: 70,
            maxSelectedNodes: 3,
            kindLimits: {
                entity: 0,
                event: 1,
                state: 1,
                claim: 1,
                thread: 1,
            },
        } as const

        expect(inquireNarrativeMemory(index, input))
            .toEqual(inquireNarrativeMemory(index, input))
        const result = inquireNarrativeMemory(index, input)
        expect(result.selected).toHaveLength(3)
        expect(result.metrics.selectedTokens).toBeLessThanOrEqual(70)
        expect(result.selected.filter(
            (item) => item.node.kind === 'event'
        ).length).toBeLessThanOrEqual(1)
    })

    it('keeps request work constant when unrelated graph nodes grow 10x', () => {
        const base = createLinaKainGraph()
        const expanded = structuredClone(base)
        const unrelated = Array.from(
            { length: base.nodes.length * 9 },
            (_, index): NarrativeNode => ({
                id: `event:noise-${index}`,
                kind: 'event',
                subtype: 'event',
                title: `잡음 ${index}`,
                summary: `현재 장면과 관계없는 고유 사건 noise-${index}`,
                storyId: base.storyId,
                branchId: base.branchId,
                status: 'active',
                authority: 'draft',
                salience: 1,
                occurredAt: 100 + index,
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
                evidence: [{
                    chatId: 'noise-chat',
                    messageId: `noise-message-${index}`,
                }],
                revision: 1,
            })
        )
        expanded.nodes.push(...unrelated)

        const baseResult = inquire(base)
        const expandedResult = inquire(expanded)

        expect(expanded.nodes.length).toBe(base.nodes.length * 10)
        expect(expandedResult.selected.map((item) => item.node.id))
            .toEqual(baseResult.selected.map((item) => item.node.id))
        expect(expandedResult.metrics.candidateCount)
            .toBe(baseResult.metrics.candidateCount)
        expect(expandedResult.metrics.inspectedNodeCount)
            .toBe(baseResult.metrics.inspectedNodeCount)
        expect(expandedResult.metrics.inspectedEdgeCount)
            .toBe(baseResult.metrics.inspectedEdgeCount)
        expect(expandedResult.metrics.selectedTokens)
            .toBe(baseResult.metrics.selectedTokens)
    })

    it('is invariant to seed ordering at the direct candidate cap', () => {
        const index = buildNarrativeIndex(createLinaKainGraph())
        const common = {
            openThreadIds: ['thread:broken-rendezvous'],
            terms: ['믿는다', '약속'],
            perspectiveEntityIds: ['entity:lina', 'entity:kain'],
            excludeUnmarkedOmniscientClaims: true,
            tokenBudget: 220,
            maxSelectedNodes: 8,
            directCandidateLimit: 8,
            candidateLimit: 8,
            hopLimit: 0 as const,
        }

        const first = inquireNarrativeMemory(index, {
            ...common,
            entityIds: ['entity:lina', 'entity:kain'],
        })
        const reordered = inquireNarrativeMemory(index, {
            ...common,
            entityIds: ['entity:kain', 'entity:lina'],
            terms: ['약속', '믿는다'],
        })

        expect(reordered).toEqual(first)
    })

    it('fails closed for character-scoped knowledge without an explicit POV', () => {
        const result = inquireNarrativeMemory(
            buildNarrativeIndex(createLinaKainGraph()),
            {
                entityIds: ['entity:lina', 'entity:kain'],
                openThreadIds: ['thread:broken-rendezvous'],
                terms: ['믿는다'],
                excludeUnmarkedOmniscientClaims: true,
                tokenBudget: 220,
            }
        )
        const selectedIds = result.selected.map((item) => item.node.id)

        expect(selectedIds).not.toContain('claim:lina-believes-betrayal')
        expect(selectedIds).not.toContain('event:kain-ambushed')
        expect(selectedIds).not.toContain('event:forged-letter-found')
    })

    it('bounds seed counts and safely treats prototype names as misses', () => {
        const index = buildNarrativeIndex(createLinaKainGraph())

        expect(inquireNarrativeMemory(index, {
            entityIds: [],
            openThreadIds: [],
            terms: ['constructor', '__proto__'],
            tokenBudget: 100,
        }).selected).toEqual([])
        expect(() => inquireNarrativeMemory(index, {
            entityIds: Array.from({ length: 17 }, (_, index) =>
                `entity:${index}`),
            openThreadIds: [],
            terms: [],
            tokenBudget: 100,
        })).toThrow('Entity seed count exceeds 16')
        expect(() => inquireNarrativeMemory(index, {
            entityIds: [],
            openThreadIds: [],
            terms: ['x'.repeat(65)],
            tokenBudget: 100,
        })).toThrow('Narrative term seed exceeds 64 characters')
    })
})

describe('narrativeInquiryToContextSources', () => {
    it('converts retrieved nodes to ordinary bounded memory sources', () => {
        const sources = narrativeInquiryToContextSources(inquire())

        expect(sources.length).toBeGreaterThan(0)
        expect(sources.every((source) =>
            source.kind === 'memory'
            && source.role === 'system'
            && source.id.startsWith('narrative-memory:')
        )).toBe(true)

        const packet = compileContext({
            budget: {
                maxContextTokens: 120,
                reservedResponseTokens: 20,
            },
            sources: [
                ...sources,
                {
                    id: 'input',
                    kind: 'user-input',
                    role: 'user',
                    content: '왜 나를 믿지 못하지?',
                    tokens: 8,
                    required: true,
                },
            ],
        })
        expect(packet.usedTokens).toBeLessThanOrEqual(100)
        expect(packet.selectedSourceIds).toContain('input')
    })
})
