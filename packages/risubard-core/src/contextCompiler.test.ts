import { describe, expect, test } from 'vitest'
import { compileContext, type ContextInput } from './contextCompiler'

describe('compileContext', () => {
    test('keeps required sources and fills the remaining budget by priority', () => {
        const input: ContextInput = {
            budget: {
                maxContextTokens: 12,
                reservedResponseTokens: 2,
            },
            sources: [
                {
                    id: 'scene',
                    kind: 'scene',
                    role: 'system',
                    content: 'Current scene',
                    tokens: 4,
                    priority: 100,
                },
                {
                    id: 'memory',
                    kind: 'memory',
                    role: 'system',
                    content: 'Older relevant memory',
                    tokens: 3,
                    priority: 50,
                    occurredAt: 10,
                },
                {
                    id: 'recent',
                    kind: 'recent',
                    role: 'assistant',
                    content: 'Most recent reply',
                    tokens: 2,
                    priority: 50,
                    occurredAt: 20,
                },
                {
                    id: 'input',
                    kind: 'user-input',
                    role: 'user',
                    content: 'Current user input',
                    tokens: 4,
                    required: true,
                },
            ],
        }

        expect(compileContext(input)).toEqual({
            inputTokenLimit: 10,
            usedTokens: 10,
            messages: [
                {
                    sourceId: 'scene',
                    role: 'system',
                    content: 'Current scene',
                },
                {
                    sourceId: 'recent',
                    role: 'assistant',
                    content: 'Most recent reply',
                },
                {
                    sourceId: 'input',
                    role: 'user',
                    content: 'Current user input',
                },
            ],
            selectedSourceIds: ['scene', 'recent', 'input'],
            omittedSourceIds: ['memory'],
            omittedSources: [
                {
                    sourceId: 'memory',
                    tokens: 3,
                    reason: 'budget',
                },
            ],
        })
    })

    test('rejects a packet when required sources exceed the input budget', () => {
        const input: ContextInput = {
            budget: {
                maxContextTokens: 8,
                reservedResponseTokens: 2,
            },
            sources: [
                {
                    id: 'static',
                    kind: 'static',
                    role: 'system',
                    content: 'Character foundation',
                    tokens: 4,
                    required: true,
                },
                {
                    id: 'input',
                    kind: 'user-input',
                    role: 'user',
                    content: 'Current user input',
                    tokens: 3,
                    required: true,
                },
            ],
        }

        expect(() => compileContext(input)).toThrowError(
            'Required context uses 7 tokens but only 6 are available'
        )
    })

    test.each([
        {
            label: 'negative source tokens',
            input: {
                budget: { maxContextTokens: 10, reservedResponseTokens: 2 },
                sources: [{
                    id: 'input',
                    kind: 'user-input' as const,
                    role: 'user' as const,
                    content: 'Input',
                    tokens: -1,
                }],
            },
        },
        {
            label: 'non-finite source tokens',
            input: {
                budget: { maxContextTokens: 10, reservedResponseTokens: 2 },
                sources: [{
                    id: 'input',
                    kind: 'user-input' as const,
                    role: 'user' as const,
                    content: 'Input',
                    tokens: Number.NaN,
                }],
            },
        },
        {
            label: 'fractional source tokens',
            input: {
                budget: { maxContextTokens: 10, reservedResponseTokens: 2 },
                sources: [{
                    id: 'input',
                    kind: 'user-input' as const,
                    role: 'user' as const,
                    content: 'Input',
                    tokens: 1.5,
                }],
            },
        },
    ])('rejects $label', ({ input }) => {
        expect(() => compileContext(input)).toThrowError(
            'Source input tokens must be a non-negative integer'
        )
    })

    test.each([
        {
            budget: { maxContextTokens: Number.NaN, reservedResponseTokens: 0 },
            message: 'maxContextTokens must be a non-negative integer',
        },
        {
            budget: { maxContextTokens: 10, reservedResponseTokens: -1 },
            message: 'reservedResponseTokens must be a non-negative integer',
        },
        {
            budget: { maxContextTokens: 10, reservedResponseTokens: 11 },
            message: 'reservedResponseTokens cannot exceed maxContextTokens',
        },
    ])('rejects invalid budget %#', ({ budget, message }) => {
        expect(() => compileContext({ budget, sources: [] })).toThrowError(message)
    })

    test('rejects empty and duplicate source IDs', () => {
        const source = {
            kind: 'memory' as const,
            role: 'system' as const,
            content: 'Memory',
            tokens: 1,
        }

        expect(() => compileContext({
            budget: { maxContextTokens: 10, reservedResponseTokens: 0 },
            sources: [{ ...source, id: ' ' }],
        })).toThrowError('Context source IDs must not be empty')

        expect(() => compileContext({
            budget: { maxContextTokens: 10, reservedResponseTokens: 0 },
            sources: [
                { ...source, id: 'memory' },
                { ...source, id: 'memory' },
            ],
        })).toThrowError('Context source IDs must be unique: memory')
    })
})
