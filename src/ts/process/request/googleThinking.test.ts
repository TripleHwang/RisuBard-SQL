import { describe, expect, test } from 'vitest'
import { resolveGeminiThinkingConfig } from './geminiThinking'

describe('resolveGeminiThinkingConfig', () => {
    test('reserves visible output for Gemini 2.5 structured calls', () => {
        expect(resolveGeminiThinkingConfig(
            'gemini-2.5-pro',
            32_768,
            true
        )).toEqual({
            thinkingBudget: 128,
            includeThoughts: false,
        })
    })

    test('uses low hidden thinking for Gemini 3 structured calls', () => {
        expect(resolveGeminiThinkingConfig(
            'gemini-3-pro-preview',
            32_768,
            true
        )).toEqual({
            thinkingLevel: 'LOW',
            includeThoughts: false,
        })
    })
})
