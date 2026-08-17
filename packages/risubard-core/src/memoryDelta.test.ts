import { describe, expect, test } from 'vitest'
import {
    applyMemoryDelta,
    type MemoryDelta,
    type NarrativeMemoryState,
} from './memoryDelta'

describe('applyMemoryDelta', () => {
    test('adds a grounded fact without mutating the input state', () => {
        const state: NarrativeMemoryState = {
            facts: [],
            events: [],
            appliedOperationIds: [],
        }
        const delta: MemoryDelta = {
            schemaVersion: 1,
            operations: [{
                type: 'add-fact',
                operationId: 'operation-1',
                factId: 'fact-1',
                text: 'Mina carries the brass key.',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-7',
                }],
            }],
        }

        const result = applyMemoryDelta(state, delta, [{
            chatId: 'chat-1',
            messageId: 'message-7',
        }])

        expect(result).toEqual({
            facts: [{
                id: 'fact-1',
                text: 'Mina carries the brass key.',
                status: 'active',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-7',
                }],
            }],
            events: [],
            appliedOperationIds: ['operation-1'],
        })
        expect(state).toEqual({
            facts: [],
            events: [],
            appliedOperationIds: [],
        })
    })

    test('rejects the whole delta when any evidence reference is unknown', () => {
        const state: NarrativeMemoryState = {
            facts: [],
            events: [],
            appliedOperationIds: [],
        }
        const delta: MemoryDelta = {
            schemaVersion: 1,
            operations: [
                {
                    type: 'add-fact',
                    operationId: 'operation-1',
                    factId: 'fact-1',
                    text: 'Grounded fact',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'message-1',
                    }],
                },
                {
                    type: 'add-fact',
                    operationId: 'operation-2',
                    factId: 'fact-2',
                    text: 'Ungrounded fact',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'missing-message',
                    }],
                },
            ],
        }

        expect(() => applyMemoryDelta(state, delta, [{
            chatId: 'chat-1',
            messageId: 'message-1',
        }])).toThrowError(
            'Unknown evidence reference: chat-1/missing-message'
        )
        expect(state).toEqual({
            facts: [],
            events: [],
            appliedOperationIds: [],
        })
    })

    test('appends a grounded event', () => {
        const state: NarrativeMemoryState = {
            facts: [],
            events: [],
            appliedOperationIds: [],
        }
        const delta = {
            schemaVersion: 1,
            operations: [{
                type: 'append-event',
                operationId: 'operation-event-1',
                eventId: 'event-1',
                summary: 'Mina opened the observatory door.',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-8',
                }],
            }],
        } as unknown as MemoryDelta

        expect(applyMemoryDelta(state, delta, [{
            chatId: 'chat-1',
            messageId: 'message-8',
        }])).toEqual({
            facts: [],
            events: [{
                id: 'event-1',
                summary: 'Mina opened the observatory door.',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-8',
                }],
            }],
            appliedOperationIds: ['operation-event-1'],
        })
    })

    test('invalidates an existing fact while preserving its original evidence', () => {
        const state: NarrativeMemoryState = {
            facts: [{
                id: 'fact-1',
                text: 'The observatory door is locked.',
                status: 'active',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-2',
                }],
            }],
            events: [],
            appliedOperationIds: [],
        }
        const delta = {
            schemaVersion: 1,
            operations: [{
                type: 'invalidate-fact',
                operationId: 'operation-invalidate-1',
                factId: 'fact-1',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-9',
                }],
            }],
        } as unknown as MemoryDelta

        expect(applyMemoryDelta(state, delta, [{
            chatId: 'chat-1',
            messageId: 'message-9',
        }])).toEqual({
            facts: [{
                id: 'fact-1',
                text: 'The observatory door is locked.',
                status: 'invalidated',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-2',
                }],
                invalidatedBy: [{
                    chatId: 'chat-1',
                    messageId: 'message-9',
                }],
            }],
            events: [],
            appliedOperationIds: ['operation-invalidate-1'],
        })
        expect(state.facts[0].status).toBe('active')
    })

    test('skips an operation that was already applied', () => {
        const state: NarrativeMemoryState = {
            facts: [{
                id: 'fact-1',
                text: 'Mina carries the brass key.',
                status: 'active',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-7',
                }],
            }],
            events: [],
            appliedOperationIds: ['operation-1'],
        }
        const delta: MemoryDelta = {
            schemaVersion: 1,
            operations: [{
                type: 'add-fact',
                operationId: 'operation-1',
                factId: 'fact-1',
                text: 'Mina carries the brass key.',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-7',
                }],
            }],
        }

        expect(applyMemoryDelta(state, delta, [{
            chatId: 'chat-1',
            messageId: 'message-7',
        }])).toEqual(state)
    })

    test.each([
        {
            label: 'unsupported schema',
            state: {
                facts: [],
                events: [],
                appliedOperationIds: [],
            },
            delta: {
                schemaVersion: 2,
                operations: [],
            },
            error: 'Unsupported MemoryDelta schema version',
        },
        {
            label: 'missing evidence',
            state: {
                facts: [],
                events: [],
                appliedOperationIds: [],
            },
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'add-fact',
                    operationId: 'operation-1',
                    factId: 'fact-1',
                    text: 'Fact',
                    evidence: [],
                }],
            },
            error: 'Operation operation-1 must include evidence',
        },
        {
            label: 'duplicate operation IDs',
            state: {
                facts: [],
                events: [],
                appliedOperationIds: [],
            },
            delta: {
                schemaVersion: 1,
                operations: [
                    {
                        type: 'append-event',
                        operationId: 'operation-1',
                        eventId: 'event-1',
                        summary: 'First event',
                        evidence: [{
                            chatId: 'chat-1',
                            messageId: 'message-1',
                        }],
                    },
                    {
                        type: 'append-event',
                        operationId: 'operation-1',
                        eventId: 'event-2',
                        summary: 'Second event',
                        evidence: [{
                            chatId: 'chat-1',
                            messageId: 'message-1',
                        }],
                    },
                ],
            },
            error: 'Duplicate operation ID: operation-1',
        },
        {
            label: 'existing fact ID',
            state: {
                facts: [{
                    id: 'fact-1',
                    text: 'Existing fact',
                    status: 'active' as const,
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'message-1',
                    }],
                }],
                events: [],
                appliedOperationIds: [],
            },
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'add-fact',
                    operationId: 'operation-1',
                    factId: 'fact-1',
                    text: 'Conflicting fact',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'message-1',
                    }],
                }],
            },
            error: 'Fact already exists: fact-1',
        },
        {
            label: 'unknown fact invalidation',
            state: {
                facts: [],
                events: [],
                appliedOperationIds: [],
            },
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'invalidate-fact',
                    operationId: 'operation-1',
                    factId: 'missing-fact',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'message-1',
                    }],
                }],
            },
            error: 'Cannot invalidate unknown or inactive fact: missing-fact',
        },
    ])('rejects $label atomically', ({ state, delta, error }) => {
        const originalState = structuredClone(state)

        expect(() => applyMemoryDelta(
            state,
            delta as unknown as MemoryDelta,
            [{ chatId: 'chat-1', messageId: 'message-1' }]
        )).toThrowError(error)
        expect(state).toEqual(originalState)
    })

    test('rejects unknown evidence even on an already-applied operation', () => {
        const state: NarrativeMemoryState = {
            facts: [],
            events: [],
            appliedOperationIds: ['operation-old'],
        }
        const delta = {
            schemaVersion: 1,
            operations: [
                {
                    type: 'append-event',
                    operationId: 'operation-old',
                    eventId: 'event-old',
                    summary: 'Previously applied',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'fabricated',
                    }],
                },
                {
                    type: 'append-event',
                    operationId: 'operation-new',
                    eventId: 'event-new',
                    summary: 'New valid event',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'message-1',
                    }],
                },
            ],
        }

        expect(() => applyMemoryDelta(state, delta, [{
            chatId: 'chat-1',
            messageId: 'message-1',
        }])).toThrowError('Unknown evidence reference: chat-1/fabricated')
        expect(state.events).toEqual([])
    })

    test('does not confuse evidence IDs containing null characters', () => {
        const delta = {
            schemaVersion: 1,
            operations: [{
                type: 'append-event',
                operationId: 'operation-1',
                eventId: 'event-1',
                summary: 'Event',
                evidence: [{
                    chatId: 'chat\u0000other',
                    messageId: 'message',
                }],
            }],
        }

        expect(() => applyMemoryDelta({
            facts: [],
            events: [],
            appliedOperationIds: [],
        }, delta, [{
            chatId: 'chat',
            messageId: 'other\u0000message',
        }])).toThrowError(
            'Unknown evidence reference: chat\u0000other/message'
        )
    })

    test('rejects file paths and other fields outside the operation contract', () => {
        const delta = {
            schemaVersion: 1,
            operations: [{
                type: 'append-event',
                operationId: 'operation-1',
                eventId: 'event-1',
                summary: 'Event',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-1',
                }],
                path: '../../wiki/scene.md',
            }],
        }

        expect(() => applyMemoryDelta({
            facts: [],
            events: [],
            appliedOperationIds: [],
        }, delta, [{
            chatId: 'chat-1',
            messageId: 'message-1',
        }])).toThrowError('Unexpected append-event field: path')
    })
})
