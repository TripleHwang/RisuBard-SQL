import { describe, expect, test } from 'vitest'
import type { ContextPacket } from '../../../packages/risubard-core/src/contextCompiler'
import { compareShadowContext } from './shadowContext'

describe('compareShadowContext', () => {
    test('reports prompt differences without changing the legacy messages', () => {
        const legacyMessages = [
            { role: 'system' as const, content: 'Character foundation' },
            { role: 'user' as const, content: 'Old message' },
            { role: 'user' as const, content: 'Current input' },
        ]
        const originalLegacyMessages = structuredClone(legacyMessages)
        const candidate: ContextPacket = {
            inputTokenLimit: 100,
            usedTokens: 12,
            messages: [
                {
                    sourceId: 'static',
                    role: 'system',
                    content: 'Character foundation',
                },
                {
                    sourceId: 'input',
                    role: 'user',
                    content: 'Current input',
                },
            ],
            selectedSourceIds: ['static', 'input'],
            omittedSourceIds: ['old-message'],
            omittedSources: [{
                sourceId: 'old-message',
                tokens: 8,
                reason: 'budget',
            }],
        }

        expect(compareShadowContext({
            legacyMessages,
            legacyEstimatedTokens: 20,
            candidate,
        })).toEqual({
            identicalMessages: false,
            legacyMessageCount: 3,
            candidateMessageCount: 2,
            legacyEstimatedTokens: 20,
            candidateTokens: 12,
            selectedSourceIds: ['static', 'input'],
            omittedSourceIds: ['old-message'],
        })
        expect(legacyMessages).toEqual(originalLegacyMessages)
    })

    test('treats provider-relevant legacy metadata as a message difference', () => {
        const candidate: ContextPacket = {
            inputTokenLimit: 100,
            usedTokens: 4,
            messages: [{
                sourceId: 'input',
                role: 'user',
                content: 'Current input',
            }],
            selectedSourceIds: ['input'],
            omittedSourceIds: [],
            omittedSources: [],
        }

        expect(compareShadowContext({
            legacyMessages: [{
                role: 'user',
                content: 'Current input',
                name: 'speaker',
            }],
            legacyEstimatedTokens: 4,
            candidate,
        }).identicalMessages).toBe(false)
    })

    test('accepts the inherited function role in legacy messages', () => {
        const candidate: ContextPacket = {
            inputTokenLimit: 100,
            usedTokens: 0,
            messages: [],
            selectedSourceIds: [],
            omittedSourceIds: [],
            omittedSources: [],
        }

        expect(compareShadowContext({
            legacyMessages: [{
                role: 'function',
                content: 'Tool result',
            }],
            legacyEstimatedTokens: 2,
            candidate,
        }).identicalMessages).toBe(false)
    })
})
