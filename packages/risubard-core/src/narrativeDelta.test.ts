import { describe, expect, test } from 'vitest'
import type {
    NarrativeGraphStateV2,
    NarrativeNode,
} from './narrativeGraph'
import {
    applyNarrativeGraphDelta,
    createV1ReconciliationDelta,
    projectMemoryDeltaToNarrativeGraphDelta,
    type NarrativeGraphDeltaV2,
} from './narrativeDelta'

const evidence = [{ chatId: 'chat-1', messageId: 'message-1' }]

function character(id: string): Omit<NarrativeNode, 'revision'> {
    return {
        id,
        kind: 'entity',
        subtype: 'character',
        title: id,
        summary: `${id} summary`,
        storyId: 'story-1',
        branchId: 'chat-1',
        status: 'active',
        authority: 'draft',
        salience: 5,
        perspective: { kind: 'omniscient' },
        epistemic: 'fact',
        evidence: structuredClone(evidence),
    }
}

function emptyGraph(): NarrativeGraphStateV2 {
    return {
        schemaVersion: 2,
        storyId: 'story-1',
        branchId: 'chat-1',
        revision: 0,
        nodes: [],
        edges: [],
        appliedOperationIds: [],
    }
}

function validDelta(): NarrativeGraphDeltaV2 {
    return {
        schemaVersion: 2,
        storyId: 'story-1',
        branchId: 'chat-1',
        operations: [
            {
                type: 'add-node',
                operationId: 'operation-character',
                node: character('entity:lina'),
            },
            {
                type: 'add-node',
                operationId: 'operation-belief',
                node: {
                    id: 'claim:lina-belief',
                    kind: 'claim',
                    subtype: 'belief',
                    title: 'Lina distrusts Kain',
                    summary: 'Lina believes Kain betrayed her.',
                    storyId: 'story-1',
                    branchId: 'chat-1',
                    status: 'active',
                    authority: 'draft',
                    salience: 8,
                    perspective: {
                        kind: 'character',
                        entityId: 'entity:lina',
                    },
                    epistemic: 'belief',
                    evidence: structuredClone(evidence),
                },
            },
            {
                type: 'add-edge',
                operationId: 'operation-holder',
                edge: {
                    id: 'edge:lina-belief-holder',
                    sourceId: 'claim:lina-belief',
                    type: 'believed_by',
                    targetId: 'entity:lina',
                    storyId: 'story-1',
                    branchId: 'chat-1',
                    evidence: structuredClone(evidence),
                },
            },
        ],
    }
}

describe('applyNarrativeGraphDelta', () => {
    test('applies strict node and edge operations at one revision without input mutation', () => {
        const state = emptyGraph()
        const delta = validDelta()
        const originalState = structuredClone(state)
        const originalDelta = structuredClone(delta)

        const result = applyNarrativeGraphDelta(state, delta, evidence)

        expect(result.revision).toBe(1)
        expect(result.nodes.map((node) => [node.id, node.revision])).toEqual([
            ['entity:lina', 1],
            ['claim:lina-belief', 1],
        ])
        expect(result.edges).toMatchObject([{
            id: 'edge:lina-belief-holder',
            revision: 1,
        }])
        expect(result.appliedOperationIds).toEqual([
            'operation-character',
            'operation-belief',
            'operation-holder',
        ])
        expect(state).toEqual(originalState)
        expect(delta).toEqual(originalDelta)
    })

    test('updates status without overwriting the node body or original evidence', () => {
        const state = applyNarrativeGraphDelta(
            emptyGraph(),
            {
                schemaVersion: 2,
                storyId: 'story-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'add-node',
                    operationId: 'operation-add',
                    node: character('entity:lina'),
                }],
            },
            evidence
        )

        const result = applyNarrativeGraphDelta(state, {
            schemaVersion: 2,
            storyId: 'story-1',
            branchId: 'chat-1',
            operations: [{
                type: 'update-node-status',
                operationId: 'operation-resolve',
                nodeId: 'entity:lina',
                status: 'resolved',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-2',
                }],
            }],
        }, [...evidence, {
            chatId: 'chat-1',
            messageId: 'message-2',
        }])

        expect(result.revision).toBe(2)
        expect(result.nodes[0]).toMatchObject({
            id: 'entity:lina',
            summary: 'entity:lina summary',
            status: 'resolved',
            revision: 2,
            evidence,
            statusEvidence: [{
                chatId: 'chat-1',
                messageId: 'message-2',
            }],
        })
    })

    test.each([
        ['duplicate operation ID', (delta: NarrativeGraphDeltaV2) => {
            delta.operations[1].operationId = delta.operations[0].operationId
        }, 'Duplicate narrative operation ID'],
        ['duplicate node ID', (delta: NarrativeGraphDeltaV2) => {
            if (delta.operations[1].type === 'add-node') {
                delta.operations[1].node.id = 'entity:lina'
                delta.operations[1].node.kind = 'entity'
                delta.operations[1].node.subtype = 'character'
                delta.operations[1].node.perspective = { kind: 'omniscient' }
                delta.operations[1].node.epistemic = 'fact'
            }
        }, 'Narrative node already exists'],
        ['duplicate edge ID', (delta: NarrativeGraphDeltaV2) => {
            delta.operations.push({
                ...structuredClone(delta.operations[2]),
                operationId: 'operation-holder-copy',
            } as NarrativeGraphDeltaV2['operations'][number])
        }, 'Narrative edge already exists'],
        ['unknown evidence', (delta: NarrativeGraphDeltaV2) => {
            if (delta.operations[0].type === 'add-node') {
                delta.operations[0].node.evidence[0].messageId = 'missing'
            }
        }, 'Unknown narrative evidence reference'],
        ['mixed story scope', (delta: NarrativeGraphDeltaV2) => {
            if (delta.operations[0].type === 'add-node') {
                delta.operations[0].node.storyId = 'other-story'
            }
        }, 'outside graph scope'],
        ['mixed chat scope', (delta: NarrativeGraphDeltaV2) => {
            if (delta.operations[0].type === 'add-node') {
                delta.operations[0].node.evidence[0].chatId = 'other-chat'
            }
        }, 'outside delta chat scope'],
        ['invalid belief perspective', (delta: NarrativeGraphDeltaV2) => {
            if (delta.operations[1].type === 'add-node') {
                delta.operations[1].node.perspective = { kind: 'omniscient' }
            }
        }, 'Belief claims require a character perspective'],
        ['invalid relation endpoint', (delta: NarrativeGraphDeltaV2) => {
            if (delta.operations[2].type === 'add-edge') {
                delta.operations[2].edge.targetId = 'claim:lina-belief'
            }
        }, 'believed_by must connect a claim to a character'],
    ])('rejects %s atomically', (_label, mutate, error) => {
        const state = emptyGraph()
        const delta = validDelta()
        mutate(delta)

        expect(() => applyNarrativeGraphDelta(
            state,
            delta,
            evidence
        )).toThrowError(error)
        expect(state).toEqual(emptyGraph())
    })

    test('validates replays but does not duplicate or advance the revision', () => {
        const applied = applyNarrativeGraphDelta(
            emptyGraph(),
            validDelta(),
            evidence
        )

        expect(applyNarrativeGraphDelta(
            applied,
            validDelta(),
            evidence
        )).toEqual(applied)
        const invalidReplay = validDelta()
        if (invalidReplay.operations[0].type === 'add-node') {
            invalidReplay.operations[0].node.evidence[0].messageId = 'missing'
        }
        expect(() => applyNarrativeGraphDelta(
            applied,
            invalidReplay,
            evidence
        )).toThrow('Unknown narrative evidence reference')
    })

    test.each([
        ['add-node', (delta: NarrativeGraphDeltaV2) => {
            if (delta.operations[0].type === 'add-node') {
                delta.operations[0].node.summary = 'Changed payload'
            }
        }],
        ['add-edge', (delta: NarrativeGraphDeltaV2) => {
            if (delta.operations[2].type === 'add-edge') {
                delta.operations[2].edge.id = 'edge:changed'
            }
        }],
    ])('rejects an applied %s operation ID with a changed payload', (
        _label,
        mutate
    ) => {
        const applied = applyNarrativeGraphDelta(
            emptyGraph(),
            validDelta(),
            evidence
        )
        const replay = validDelta()
        mutate(replay)

        expect(() => applyNarrativeGraphDelta(
            applied,
            replay,
            evidence
        )).toThrow('Narrative operation payload mismatch')
    })

    test('rejects an applied status operation ID with changed evidence', () => {
        const added = applyNarrativeGraphDelta(
            emptyGraph(),
            {
                schemaVersion: 2,
                storyId: 'story-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'add-node',
                    operationId: 'operation-add',
                    node: character('entity:lina'),
                }],
            },
            evidence
        )
        const statusDelta: NarrativeGraphDeltaV2 = {
            schemaVersion: 2,
            storyId: 'story-1',
            branchId: 'chat-1',
            operations: [{
                type: 'update-node-status',
                operationId: 'operation-status',
                nodeId: 'entity:lina',
                status: 'resolved',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-2',
                }],
            }],
        }
        const available = [...evidence, {
            chatId: 'chat-1',
            messageId: 'message-2',
        }]
        const applied = applyNarrativeGraphDelta(
            added,
            statusDelta,
            available
        )
        const changed = structuredClone(statusDelta)
        if (changed.operations[0].type === 'update-node-status') {
            changed.operations[0].evidence = evidence
        }

        expect(() => applyNarrativeGraphDelta(
            applied,
            changed,
            available
        )).toThrow('Narrative operation payload mismatch')
    })

    test('binds an applied status operation ID to its original node', () => {
        const added = applyNarrativeGraphDelta(
            emptyGraph(),
            {
                schemaVersion: 2,
                storyId: 'story-1',
                branchId: 'chat-1',
                operations: [
                    {
                        type: 'add-node',
                        operationId: 'operation-add-lina',
                        node: character('entity:lina'),
                    },
                    {
                        type: 'add-node',
                        operationId: 'operation-add-kain',
                        node: character('entity:kain'),
                    },
                ],
            },
            evidence
        )
        const statusEvidence = [{
            chatId: 'chat-1',
            messageId: 'message-2',
        }]
        const available = [...evidence, ...statusEvidence]
        const applied = applyNarrativeGraphDelta(
            added,
            {
                schemaVersion: 2,
                storyId: 'story-1',
                branchId: 'chat-1',
                operations: [
                    {
                        type: 'update-node-status',
                        operationId: 'operation-status-lina',
                        nodeId: 'entity:lina',
                        status: 'resolved',
                        evidence: statusEvidence,
                    },
                    {
                        type: 'update-node-status',
                        operationId: 'operation-status-kain',
                        nodeId: 'entity:kain',
                        status: 'resolved',
                        evidence: statusEvidence,
                    },
                ],
            },
            available
        )

        expect(() => applyNarrativeGraphDelta(
            applied,
            {
                schemaVersion: 2,
                storyId: 'story-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'update-node-status',
                    operationId: 'operation-status-lina',
                    nodeId: 'entity:kain',
                    status: 'resolved',
                    evidence: statusEvidence,
                }],
            },
            available
        )).toThrow('Narrative operation payload mismatch')
    })
})

describe('projectMemoryDeltaToNarrativeGraphDelta', () => {
    test('projects validated v1 operations with stable IDs and evidence', () => {
        expect(projectMemoryDeltaToNarrativeGraphDelta({
            schemaVersion: 1,
            operations: [
                {
                    type: 'add-fact',
                    operationId: 'operation-fact',
                    factId: 'gate-state',
                    text: 'The gate is open.',
                    evidence,
                },
                {
                    type: 'append-event',
                    operationId: 'operation-event',
                    eventId: 'gate-opened',
                    summary: 'Lina opened the gate.',
                    evidence,
                },
                {
                    type: 'invalidate-fact',
                    operationId: 'operation-invalidate',
                    factId: 'old-gate-state',
                    evidence,
                },
            ],
        }, 'story-1', 'chat-1')).toEqual({
            schemaVersion: 2,
            storyId: 'story-1',
            branchId: 'chat-1',
            operations: [
                {
                    type: 'add-node',
                    operationId: 'operation-fact',
                    node: {
                        id: 'claim:v1:gate-state',
                        kind: 'claim',
                        subtype: 'fact',
                        title: 'The gate is open.',
                        summary: 'The gate is open.',
                        storyId: 'story-1',
                        branchId: 'chat-1',
                        status: 'active',
                        authority: 'draft',
                        salience: 5,
                        perspective: { kind: 'omniscient' },
                        epistemic: 'fact',
                        evidence,
                    },
                },
                {
                    type: 'add-node',
                    operationId: 'operation-event',
                    node: {
                        id: 'event:v1:gate-opened',
                        kind: 'event',
                        subtype: 'event',
                        title: 'Lina opened the gate.',
                        summary: 'Lina opened the gate.',
                        storyId: 'story-1',
                        branchId: 'chat-1',
                        status: 'active',
                        authority: 'draft',
                        salience: 5,
                        perspective: { kind: 'omniscient' },
                        epistemic: 'fact',
                        evidence,
                    },
                },
                {
                    type: 'update-node-status',
                    operationId: 'operation-invalidate',
                    nodeId: 'claim:v1:old-gate-state',
                    status: 'invalidated',
                    evidence,
                },
            ],
        })
    })

    test('does not mutate the v1 delta or its evidence', () => {
        const delta = {
            schemaVersion: 1 as const,
            operations: [{
                type: 'add-fact' as const,
                operationId: 'operation-fact',
                factId: 'gate-state',
                text: 'The gate is open.',
                evidence: structuredClone(evidence),
            }],
        }
        const snapshot = structuredClone(delta)

        const projected = projectMemoryDeltaToNarrativeGraphDelta(
            delta,
            'story-1',
            'chat-1'
        )
        if (projected.operations[0].type === 'add-node') {
            projected.operations[0].node.evidence[0].messageId = 'mutated'
        }

        expect(delta).toEqual(snapshot)
    })
})

describe('createV1ReconciliationDelta', () => {
    test('repairs missing v1 nodes and invalidation with stable operations', () => {
        const invalidationEvidence = [{
            chatId: 'chat-1',
            messageId: 'message-2',
        }]

        expect(createV1ReconciliationDelta({
            facts: [
                {
                    id: 'gate-open',
                    text: 'The gate is open.',
                    status: 'active',
                    evidence,
                },
                {
                    id: 'torch-lit',
                    text: 'The torch is lit.',
                    status: 'invalidated',
                    evidence,
                    invalidatedBy: invalidationEvidence,
                },
            ],
            events: [{
                id: 'gate-opened',
                summary: 'Lina opened the gate.',
                evidence,
            }],
            appliedOperationIds: [],
        }, emptyGraph())).toEqual({
            schemaVersion: 2,
            storyId: 'story-1',
            branchId: 'chat-1',
            operations: [
                expect.objectContaining({
                    type: 'add-node',
                    operationId: 'reconcile:v1:add:claim:v1:gate-open',
                    node: expect.objectContaining({
                        id: 'claim:v1:gate-open',
                        status: 'active',
                        evidence,
                    }),
                }),
                expect.objectContaining({
                    type: 'add-node',
                    operationId: 'reconcile:v1:add:claim:v1:torch-lit',
                    node: expect.objectContaining({
                        id: 'claim:v1:torch-lit',
                        status: 'active',
                        evidence,
                    }),
                }),
                {
                    type: 'update-node-status',
                    operationId:
                        'reconcile:v1:status:claim:v1:torch-lit:invalidated',
                    nodeId: 'claim:v1:torch-lit',
                    status: 'invalidated',
                    evidence: invalidationEvidence,
                },
                expect.objectContaining({
                    type: 'add-node',
                    operationId: 'reconcile:v1:add:event:v1:gate-opened',
                    node: expect.objectContaining({
                        id: 'event:v1:gate-opened',
                        evidence,
                    }),
                }),
            ],
        })
    })

    test('rejects incompatible existing projected content', () => {
        const graph = emptyGraph()
        graph.nodes.push({
            ...character('claim:v1:gate-open'),
            kind: 'claim',
            subtype: 'fact',
            title: 'Changed',
            summary: 'Changed',
            revision: 1,
        })

        expect(() => createV1ReconciliationDelta({
            facts: [{
                id: 'gate-open',
                text: 'The gate is open.',
                status: 'active',
                evidence,
            }],
            events: [],
            appliedOperationIds: [],
        }, graph)).toThrow('Incompatible projected narrative node')
    })

    test('rejects stale status evidence on active projected nodes', () => {
        const graph = emptyGraph()
        graph.nodes.push({
            ...character('claim:v1:gate-open'),
            kind: 'claim',
            subtype: 'fact',
            title: 'The gate is open.',
            summary: 'The gate is open.',
            statusEvidence: evidence,
            revision: 1,
        })

        expect(() => createV1ReconciliationDelta({
            facts: [{
                id: 'gate-open',
                text: 'The gate is open.',
                status: 'active',
                evidence,
            }],
            events: [],
            appliedOperationIds: [],
        }, graph)).toThrow('Incompatible projected narrative node')
    })

    test('rejects projected graph nodes absent from current v1 state', () => {
        const graph = emptyGraph()
        graph.nodes.push({
            ...character('claim:v1:ghost'),
            kind: 'claim',
            subtype: 'fact',
            revision: 1,
        })

        expect(() => createV1ReconciliationDelta({
            facts: [],
            events: [],
            appliedOperationIds: [],
        }, graph)).toThrow(
            'Projected narrative node is absent from v1 state: claim:v1:ghost'
        )
    })
})
