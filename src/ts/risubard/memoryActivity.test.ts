import { describe, expect, it } from 'vitest'
import {
    createRisuBardContextTrace,
    sourceIdToWikiPath,
    traceRecentMessagesFromPrompt,
} from './memoryActivity'
import * as memoryActivity from './memoryActivity'

describe('RisuBard memory activity', () => {
    it('records message IDs and selected wiki paths without prompt bodies', () => {
        const trace = createRisuBardContextTrace({
            mode: 'current',
            recentMessages: [{ id: 'user-1', role: 'user' }, {
                id: 'assistant-1', role: 'char',
            }],
            selectedSourceIds: [
                'narrative-memory:wiki:current-scene.md',
                'narrative-memory:wiki:characters/라비안.md',
                'not-a-wiki-source',
            ],
            selectedTokens: 412,
            inquiryDurationMs: 18.6,
        })

        expect(trace).toEqual({
            mode: 'current',
            recentMessages: [{ id: 'user-1', role: 'user' }, {
                id: 'assistant-1', role: 'char',
            }],
            wikiPaths: ['current-scene.md', 'characters/라비안.md'],
            selectedTokens: 412,
            inquiryDurationMs: 19,
        })
        expect(JSON.stringify(trace)).not.toMatch(/prompt|api.?key|content/i)
    })

    it('rejects traversal-like source paths', () => {
        expect(sourceIdToWikiPath(
            'narrative-memory:wiki:../secret.md'
        )).toBeNull()
        expect(sourceIdToWikiPath(
            'narrative-memory:wiki:events/turn-1.md'
        )).toBe('events/turn-1.md')
    })

    it('derives message provenance from the final provider prompt after trimming', () => {
        expect(traceRecentMessagesFromPrompt([
            { role: 'system', content: 'rules' },
            { role: 'function', content: 'tool result', memo: 'tool-1' },
            { role: 'user', content: 'kept', memo: 'user-9' },
            { role: 'assistant', content: 'kept', memo: 'assistant-9' },
        ])).toEqual([
            { id: 'user-9', role: 'user' },
            { id: 'assistant-9', role: 'char' },
        ])
    })

    it('retains a bounded live event for a log view mounted later', () => {
        const api = memoryActivity as unknown as {
            publishRisuBardMemoryActivity(detail: {
                characterId: string
                chatId: string
                operation: 'error'
                timestamp: number
                message: string
            }): void
            getRecentRisuBardMemoryActivity(
                characterId: string,
                chatId: string
            ): Array<{ message: string }>
        }
        expect(api.getRecentRisuBardMemoryActivity).toBeTypeOf('function')
        api.publishRisuBardMemoryActivity({
            characterId: 'late-character',
            chatId: 'late-chat',
            operation: 'error',
            timestamp: 123,
            message: '위키 조회 제한 시간을 초과했습니다.',
        })

        expect(api.getRecentRisuBardMemoryActivity(
            'late-character', 'late-chat'
        )).toEqual([
            expect.objectContaining({
                timestamp: 123,
                message: '위키 조회 제한 시간을 초과했습니다.',
            }),
        ])
    })
})
