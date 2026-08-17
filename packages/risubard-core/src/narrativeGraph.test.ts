import { describe, expect, it } from 'vitest'
import type { NarrativeMemoryState } from './memoryDelta'
import {
    adaptV1NarrativeMemory,
    validateNarrativeGraphState,
    type NarrativeGraphStateV2,
} from './narrativeGraph'

const evidence = [{ chatId: 'story-chat', messageId: 'message-1' }]

function createValidGraph(): NarrativeGraphStateV2 {
    return {
        schemaVersion: 2,
        storyId: 'story-1',
        branchId: 'main',
        revision: 3,
        nodes: [
            {
                id: 'entity:lina',
                kind: 'entity',
                subtype: 'character',
                title: 'Lina',
                summary: 'Lina is cautious.',
                storyId: 'story-1',
                branchId: 'main',
                status: 'active',
                authority: 'draft',
                salience: 5,
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
                evidence,
                revision: 1,
            },
            {
                id: 'claim:lina-betrayal',
                kind: 'claim',
                subtype: 'belief',
                title: 'Lina suspects betrayal',
                summary: 'Lina believes Kain betrayed her.',
                storyId: 'story-1',
                branchId: 'main',
                status: 'active',
                authority: 'draft',
                salience: 8,
                perspective: {
                    kind: 'character',
                    entityId: 'entity:lina',
                },
                epistemic: 'belief',
                evidence,
                revision: 1,
            },
        ],
        edges: [
            {
                id: 'edge:belief-holder',
                sourceId: 'claim:lina-betrayal',
                type: 'believed_by',
                targetId: 'entity:lina',
                storyId: 'story-1',
                branchId: 'main',
                evidence,
                revision: 1,
            },
        ],
        appliedOperationIds: ['operation-1'],
    }
}

describe('validateNarrativeGraphState', () => {
    it('strictly accepts the minimum v2 node and relation contract', () => {
        expect(validateNarrativeGraphState(createValidGraph()))
            .toEqual(createValidGraph())
    })

    it('rejects unsupported kinds, relations, dangling edges and extra fields', () => {
        const unsupportedKind = structuredClone(createValidGraph()) as any
        unsupportedKind.nodes[0].kind = 'document'
        expect(() => validateNarrativeGraphState(unsupportedKind))
            .toThrow('Unsupported narrative node kind')

        const unsupportedRelation = structuredClone(createValidGraph()) as any
        unsupportedRelation.edges[0].type = 'knows'
        expect(() => validateNarrativeGraphState(unsupportedRelation))
            .toThrow('Unsupported narrative edge type')

        const dangling = structuredClone(createValidGraph())
        dangling.edges[0].targetId = 'entity:missing'
        expect(() => validateNarrativeGraphState(dangling))
            .toThrow('Narrative edge target does not exist')

        const extra = structuredClone(createValidGraph()) as any
        extra.nodes[0].body = 'not allowed'
        expect(() => validateNarrativeGraphState(extra))
            .toThrow('Unexpected narrative node field: body')
    })

    it('requires character perspective and belief epistemic on belief claims', () => {
        const graph = structuredClone(createValidGraph()) as any
        graph.nodes[1].perspective = { kind: 'omniscient' }
        expect(() => validateNarrativeGraphState(graph))
            .toThrow('Belief claims require a character perspective')

        graph.nodes[1].perspective = {
            kind: 'character',
            entityId: 'entity:lina',
        }
        graph.nodes[1].epistemic = 'fact'
        expect(() => validateNarrativeGraphState(graph))
            .toThrow('Belief claims require belief epistemic status')
    })

    it('requires valid character perspectives and relation endpoints', () => {
        const missingPerspective = structuredClone(createValidGraph())
        const belief = missingPerspective.nodes[1]
        belief.perspective = {
            kind: 'character',
            entityId: 'entity:missing',
        }
        expect(() => validateNarrativeGraphState(missingPerspective))
            .toThrow('Perspective character does not exist')

        const invalidEndpoint = structuredClone(createValidGraph())
        invalidEndpoint.edges[0].sourceId = 'entity:lina'
        invalidEndpoint.edges[0].targetId = 'claim:lina-betrayal'
        expect(() => validateNarrativeGraphState(invalidEndpoint))
            .toThrow('believed_by must connect a claim to a character')
    })

    it('keeps fact claims omniscient and belief holders consistent', () => {
        const factWithBeliefSemantics = structuredClone(
            createValidGraph()
        ) as any
        factWithBeliefSemantics.nodes[0] = {
            ...factWithBeliefSemantics.nodes[1],
            id: 'claim:bad-fact',
            subtype: 'fact',
        }
        factWithBeliefSemantics.edges = []
        expect(() => validateNarrativeGraphState(factWithBeliefSemantics))
            .toThrow('Fact claims require omniscient fact semantics')

        const wrongHolder = structuredClone(createValidGraph())
        wrongHolder.nodes.push({
            ...wrongHolder.nodes[0],
            id: 'entity:kain',
            title: 'Kain',
            summary: 'Kain is present.',
        })
        wrongHolder.edges[0].targetId = 'entity:kain'
        expect(() => validateNarrativeGraphState(wrongHolder))
            .toThrow('believed_by holder must match claim perspective')
    })
})

describe('adaptV1NarrativeMemory', () => {
    it('projects v1 facts and events deterministically without mutating input', () => {
        const state: NarrativeMemoryState = {
            facts: [
                {
                    id: 'trust',
                    text: 'Lina distrusts Kain.',
                    status: 'active',
                    evidence,
                },
                {
                    id: 'old-trust',
                    text: 'Lina trusted Kain.',
                    status: 'invalidated',
                    evidence,
                    invalidatedBy: evidence,
                },
            ],
            events: [{
                id: 'ambush',
                summary: 'Kain was ambushed.',
                evidence,
            }],
            appliedOperationIds: ['operation-1'],
        }
        const original = structuredClone(state)

        const graph = adaptV1NarrativeMemory({
            state,
            storyId: 'story-1',
            branchId: 'main',
        })

        expect(graph.nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            subtype: node.subtype,
            status: node.status,
            summary: node.summary,
        }))).toEqual([
            {
                id: 'claim:v1:trust',
                kind: 'claim',
                subtype: 'fact',
                status: 'active',
                summary: 'Lina distrusts Kain.',
            },
            {
                id: 'claim:v1:old-trust',
                kind: 'claim',
                subtype: 'fact',
                status: 'invalidated',
                summary: 'Lina trusted Kain.',
            },
            {
                id: 'event:v1:ambush',
                kind: 'event',
                subtype: 'event',
                status: 'active',
                summary: 'Kain was ambushed.',
            },
        ])
        expect(graph.appliedOperationIds).toEqual(['operation-1'])
        expect(graph.edges).toEqual([])
        expect(state).toEqual(original)
    })

    it('rejects v1 records without message evidence', () => {
        expect(() => adaptV1NarrativeMemory({
            storyId: 'story-1',
            branchId: 'main',
            state: {
                facts: [{
                    id: 'unsupported',
                    text: 'No evidence.',
                    status: 'active',
                    evidence: [],
                }],
                events: [],
                appliedOperationIds: [],
            },
        })).toThrow('Narrative node must include evidence')
    })
})
