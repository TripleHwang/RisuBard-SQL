import { describe, expect, it } from 'vitest'
import {
    canBranchFromMessage,
    getBardWikiEvidenceMessageIds,
} from './chatHistoryPolicy'

type TestMessage = {
    chatId?: string
    risubardCanonicalReceipt?: {
        sourceMessageIds: string[]
    }
}

describe('BardWiki chat history policy', () => {
    const messages: TestMessage[] = [
        { chatId: 'user-1' },
        {
            chatId: 'char-1',
            risubardCanonicalReceipt: {
                sourceMessageIds: ['user-1', 'char-1'],
            },
        },
        { chatId: 'user-2' },
        { chatId: 'char-2' },
    ]

    it('collects every source message referenced by a canonical receipt', () => {
        expect([...getBardWikiEvidenceMessageIds(messages)]).toEqual([
            'user-1',
            'char-1',
        ])
    })

    it('allows branching only from the current final message', () => {
        expect(canBranchFromMessage(messages, 2)).toBe(false)
        expect(canBranchFromMessage(messages, 3)).toBe(true)
        expect(canBranchFromMessage(messages, -1)).toBe(false)
        expect(canBranchFromMessage([], 0)).toBe(false)
    })

    it('keeps historical branching available when the chat has no BardWiki evidence', () => {
        const ordinaryMessages: TestMessage[] = [
            { chatId: 'user-1' },
            { chatId: 'char-1' },
            { chatId: 'user-2' },
        ]

        expect(canBranchFromMessage(ordinaryMessages, 0)).toBe(true)
        expect(canBranchFromMessage(ordinaryMessages, 1)).toBe(true)
        expect(canBranchFromMessage(ordinaryMessages, 2)).toBe(true)
    })
})
