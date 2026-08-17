import { describe, expect, test } from 'vitest'
import {
    createShadowContextReport,
    tryCountShadowMessageTokens,
    tryCreateShadowContextReport,
} from './shadowPipeline'

describe('createShadowContextReport', () => {
    test('projects pre-request messages into a bounded shadow packet', () => {
        const result = createShadowContextReport({
            legacyMessages: [
                { role: 'system', content: 'Character foundation' },
                { role: 'user', content: 'Older user message' },
                { role: 'assistant', content: 'Most recent reply' },
                { role: 'user', content: 'Current input' },
            ],
            messageTokens: [3, 3, 3, 3],
            maxContextTokens: 11,
            reservedResponseTokens: 2,
            legacyEstimatedTokens: 12,
        })

        expect(result).toEqual({
            identicalMessages: false,
            legacyMessageCount: 4,
            candidateMessageCount: 3,
            legacyEstimatedTokens: 12,
            candidateTokens: 9,
            selectedSourceIds: [
                'legacy-message:0',
                'legacy-message:2',
                'legacy-message:3',
            ],
            omittedSourceIds: ['legacy-message:1'],
        })
    })

    test('preserves inherited function messages through the tool role', () => {
        const result = createShadowContextReport({
            legacyMessages: [
                { role: 'function', content: 'Tool result' },
            ],
            messageTokens: [2],
            maxContextTokens: 10,
            reservedResponseTokens: 0,
            legacyEstimatedTokens: 2,
        })

        expect(result).toEqual({
            identicalMessages: true,
            legacyMessageCount: 1,
            candidateMessageCount: 1,
            legacyEstimatedTokens: 2,
            candidateTokens: 2,
            selectedSourceIds: ['legacy-message:0'],
            omittedSourceIds: [],
        })
    })

    test('rejects mismatched message and token counts', () => {
        expect(() => createShadowContextReport({
            legacyMessages: [
                { role: 'user', content: 'Current input' },
            ],
            messageTokens: [],
            maxContextTokens: 10,
            reservedResponseTokens: 0,
            legacyEstimatedTokens: 1,
        })).toThrowError('Shadow message and token counts must match')
    })

    test('returns shadow failures without throwing into the request path', () => {
        expect(tryCreateShadowContextReport({
            legacyMessages: [
                { role: 'user', content: 'Current input' },
            ],
            messageTokens: [],
            maxContextTokens: 10,
            reservedResponseTokens: 0,
            legacyEstimatedTokens: 1,
        })).toEqual({
            status: 'error',
            error: 'Shadow message and token counts must match',
        })
    })

    test('contains shadow-only tokenizer failures', async () => {
        const tokens = await tryCountShadowMessageTokens(
            { role: 'user', content: '' },
            async () => {
                throw new Error('Tokenizer failed')
            }
        )

        expect(tokens).toBe(Number.NaN)
    })
})
