import { describe, expect, test } from 'vitest'
import type { NarrativeGraphStateV2 } from './narrativeGraph'
import { applyNarrativeGraphDelta } from './narrativeDelta'
import { compileWriterCommand } from './writerCommand'

function graph(
    source: 'event' | 'claim' | 'entity' = 'event'
): NarrativeGraphStateV2 {
    const common = {
        storyId: 'character',
        branchId: 'chat',
        status: 'active' as const,
        authority: 'draft' as const,
        salience: 5,
        perspective: { kind: 'omniscient' as const },
        epistemic: 'fact' as const,
        evidence: [{
            chatId: 'chat',
            messageId: 'message-market',
        }],
        revision: 3,
    }
    const node = source === 'event'
        ? {
            ...common,
            id: 'event:v1:market-collision',
            kind: 'event' as const,
            subtype: 'event' as const,
            title: 'Market collision',
            summary: 'The protagonist collided with a blue-haired elf.',
            occurredAt: 3,
        }
        : source === 'claim'
            ? {
                ...common,
                id: 'claim:v1:blue-haired-elf',
                kind: 'claim' as const,
                subtype: 'fact' as const,
                title: 'Blue-haired elf',
                summary: 'A blue-haired elf appeared in the market.',
            }
            : {
                ...common,
                id: 'entity:existing',
                kind: 'entity' as const,
                subtype: 'character' as const,
                title: 'Existing',
                summary: 'Existing character.',
            }
    return {
        schemaVersion: 2,
        storyId: 'character',
        branchId: 'chat',
        revision: 3,
        nodes: [node],
        edges: [],
        appliedOperationIds: [],
        appliedOperationBindings: [],
    }
}

function command() {
    return {
        schemaVersion: 1,
        type: 'promote-character',
        commandId: 'promotion-eliana',
        storyId: 'character',
        branchId: 'chat',
        sourceNodeId: 'event:v1:market-collision',
        name: ' Eliana ',
        summary: ' Eliana is the blue-haired elf from the market. ',
        salience: 9,
    }
}

describe('compileWriterCommand', () => {
    test('compiles an event mention into compatible fact and native character operations', () => {
        const input = command()
        const before = structuredClone(input)

        const result = compileWriterCommand(input, graph())

        expect(input).toEqual(before)
        expect(result.command).toEqual({
            ...input,
            name: 'Eliana',
            summary: 'Eliana is the blue-haired elf from the market.',
        })
        expect(result.availableEvidence).toEqual([{
            chatId: 'chat',
            messageId: 'message-market',
        }])
        expect(result.memoryDelta).toEqual({
            schemaVersion: 1,
            operations: [{
                type: 'add-fact',
                operationId: 'writer:promotion-eliana:fact',
                factId: 'writer:promotion-eliana:character-fact',
                text: 'Eliana is the blue-haired elf from the market.',
                evidence: [{
                    chatId: 'chat',
                    messageId: 'message-market',
                }],
            }],
        })
        expect(result.graphDelta.operations).toHaveLength(4)
        expect(result.graphDelta.operations).toEqual([
            expect.objectContaining({
                type: 'add-node',
                operationId: 'writer:promotion-eliana:fact',
                node: expect.objectContaining({
                    id: 'claim:v1:writer:promotion-eliana:character-fact',
                    kind: 'claim',
                }),
            }),
            {
                type: 'add-node',
                operationId: 'writer:promotion-eliana:entity',
                node: expect.objectContaining({
                    id: 'entity:writer:promotion-eliana',
                    kind: 'entity',
                    subtype: 'character',
                    title: 'Eliana',
                    summary: 'Eliana is the blue-haired elf from the market.',
                    authority: 'canonical',
                    salience: 9,
                }),
            },
            {
                type: 'add-edge',
                operationId: 'writer:promotion-eliana:source-relation',
                edge: expect.objectContaining({
                    sourceId: 'event:v1:market-collision',
                    type: 'involves',
                    targetId: 'entity:writer:promotion-eliana',
                }),
            },
            {
                type: 'add-edge',
                operationId: 'writer:promotion-eliana:fact-relation',
                edge: expect.objectContaining({
                    sourceId:
                        'claim:v1:writer:promotion-eliana:character-fact',
                    type: 'about',
                    targetId: 'entity:writer:promotion-eliana',
                }),
            },
        ])
    })

    test('uses about when promoting a claim mention', () => {
        const input = {
            ...command(),
            sourceNodeId: 'claim:v1:blue-haired-elf',
        }

        const result = compileWriterCommand(input, graph('claim'))

        expect(result.graphDelta.operations[2]).toEqual(
            expect.objectContaining({
                type: 'add-edge',
                edge: expect.objectContaining({ type: 'about' }),
            })
        )
    })

    test('deduplicates source evidence without changing its order', () => {
        const state = graph()
        state.nodes[0].evidence.push(
            { chatId: 'chat', messageId: 'message-market' },
            { chatId: 'chat', messageId: 'message-second' }
        )

        expect(compileWriterCommand(
            command(),
            state
        ).availableEvidence).toEqual([
            { chatId: 'chat', messageId: 'message-market' },
            { chatId: 'chat', messageId: 'message-second' },
        ])
    })

    test('rejects unsupported, inactive, or out-of-scope source nodes', () => {
        expect(() => compileWriterCommand(command(), graph('entity')))
            .toThrow('Writer source must be an active event or claim')

        const inactive = graph()
        inactive.nodes[0].status = 'resolved'
        expect(() => compileWriterCommand(command(), inactive))
            .toThrow('Writer source must be an active event or claim')

        expect(() => compileWriterCommand({
            ...command(),
            storyId: 'other',
        }, graph())).toThrow('Writer command is outside graph scope')
    })

    test.each([
        [{ ...command(), extra: true }, 'Unexpected writer command field'],
        [{ ...command(), commandId: '../unsafe' }, 'Writer command ID'],
        [{ ...command(), name: ' ' }, 'Writer character name'],
        [{ ...command(), name: 'x'.repeat(121) }, 'Writer character name'],
        [{ ...command(), summary: 'x'.repeat(2_001) }, 'Writer summary'],
        [{ ...command(), salience: 0 }, 'Writer salience'],
        [{ ...command(), salience: 11 }, 'Writer salience'],
        [{ ...command(), salience: 5.5 }, 'Writer salience'],
    ])('rejects invalid bounded input %#', (input, message) => {
        expect(() => compileWriterCommand(input, graph())).toThrow(message)
    })

    test('rejects source evidence beyond the writer route bound', () => {
        const state = graph()
        state.nodes[0].evidence = Array.from({ length: 13 }, (_, index) => ({
            chatId: 'chat',
            messageId: `message-${index}`,
        }))

        expect(() => compileWriterCommand(command(), state))
            .toThrow('Writer source evidence exceeds 12 references')
    })

    test('recompiles the same approved command idempotently after graph storage', () => {
        const state = graph()
        const first = compileWriterCommand(command(), state)
        const applied = applyNarrativeGraphDelta(
            state,
            first.graphDelta,
            first.availableEvidence
        )

        const retry = compileWriterCommand(command(), applied)

        expect(retry.graphDelta.operations).toHaveLength(3)
        expect(retry.graphDelta.operations.map(
            (operation) => operation.operationId
        )).toEqual([
            'writer:promotion-eliana:entity',
            'writer:promotion-eliana:source-relation',
            'writer:promotion-eliana:fact-relation',
        ])
        expect(applyNarrativeGraphDelta(
            applied,
            retry.graphDelta,
            retry.availableEvidence
        )).toEqual(applied)
    })
})
