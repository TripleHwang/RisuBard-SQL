import { describe, expect, it } from 'vitest'
import {
    canBranchFromMessage,
    deletionTouchesBardWikiEvidence,
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

    it('protects a single message referenced as BardWiki evidence', () => {
        expect(deletionTouchesBardWikiEvidence(messages, 0, false)).toBe(true)
        expect(deletionTouchesBardWikiEvidence(messages, 1, false)).toBe(true)
    })

    it('protects a cascade when any removed message is BardWiki evidence', () => {
        expect(deletionTouchesBardWikiEvidence(messages, 0, true)).toBe(true)
        expect(deletionTouchesBardWikiEvidence(messages, 1, true)).toBe(true)
    })

    it('allows deleting unrelated messages', () => {
        expect(deletionTouchesBardWikiEvidence(messages, 2, false)).toBe(false)
        expect(deletionTouchesBardWikiEvidence(messages, 2, true)).toBe(false)
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
