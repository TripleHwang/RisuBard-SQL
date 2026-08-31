import { describe, expect, test } from 'vitest'
import { findHistoricalSourceMatches } from './historicalSourceRecall'

describe('historical source recall', () => {
    test('recovers a small early detail from a one-thousand-message chat', () => {
        const currentInput = '샘이 프로도에게 샤이어를 떠나기 전 마지막으로 마신 에일의 맛을 기억하느냐고 묻는다.'
        const messages = Array.from({ length: 1_000 }, (_, index) => ({
            role: index % 2 === 0 ? 'user' as const : 'char' as const,
            data: `중간 여정의 일반적인 대화 ${index}`,
            chatId: `message-${index}`,
        }))
        messages[5] = {
            role: 'char',
            data: '샘과 프로도는 황금빛이 도는 플러피풋의 사과 에일을 마시며 간달프의 불꽃놀이를 감상하고 있었다.',
            chatId: 'shire-ale',
        }
        messages[999] = {
            role: 'user',
            data: currentInput,
            chatId: 'current-input',
        }

        const matches = findHistoricalSourceMatches({
            currentInput,
            messages,
            excludeRecentMessages: 12,
        })

        expect(matches[0]).toMatchObject({
            messageId: 'shire-ale',
            role: 'assistant',
            occurredAt: 5,
        })
        expect(matches[0]?.content).toContain('플러피풋의 사과 에일')
        expect(matches).toHaveLength(1)
        expect(matches.every((match) => match.content.length <= 1_200))
            .toBe(true)
    })

    test('ignores current, recent, disabled, comment, and id-less messages', () => {
        const matches = findHistoricalSourceMatches({
            currentInput: '플러피풋 사과 에일을 기억한다.',
            excludeRecentMessages: 2,
            messages: [
                { role: 'char', data: '플러피풋 사과 에일', chatId: 'old' },
                { role: 'char', data: '플러피풋 사과 에일', chatId: 'disabled', disabled: true },
                { role: 'char', data: '플러피풋 사과 에일', chatId: 'comment', isComment: true },
                { role: 'char', data: '플러피풋 사과 에일' },
                { role: 'char', data: '플러피풋 사과 에일', chatId: 'recent' },
                { role: 'user', data: '플러피풋 사과 에일을 기억한다.', chatId: 'current' },
            ],
        })

        expect(matches.map((match) => match.messageId)).toEqual(['old'])
    })

    test('does not search messages hidden behind an all-before boundary', () => {
        const matches = findHistoricalSourceMatches({
            currentInput: '플러피풋의 사과 에일을 기억한다.',
            excludeRecentMessages: 1,
            messages: [
                { role: 'char', data: '플러피풋의 사과 에일', chatId: 'hidden' },
                { role: 'user', data: '기억을 여기서 초기화한다.', chatId: 'boundary', disabled: 'allBefore' },
                { role: 'char', data: '새로운 여정이 시작됐다.', chatId: 'after' },
                { role: 'user', data: '플러피풋의 사과 에일을 기억한다.', chatId: 'current' },
            ],
        })

        expect(matches).toEqual([])
    })
})
