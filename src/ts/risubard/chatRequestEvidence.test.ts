import { describe, expect, it, vi } from 'vitest'
import type { RequestLogEntry } from 'src/ts/requestLog'

vi.mock('src/ts/requestLog', () => ({
    fetchRequestLogPage: vi.fn(),
}))
import {
    addLegacyInputEstimates,
    buildLegacyChatRequestEvidence,
    buildChatRequestEvidence,
    formatChatRequestEvidenceMarkdown,
} from './chatRequestEvidence'

const entry: RequestLogEntry = {
    id: 7,
    timestamp: Date.UTC(2026, 7, 12, 3, 4, 5),
    category: 'llm',
    source: 'main',
    chatId: 'generation-7',
    sessionChatId: 'chat-7',
    model: 'Vertex AI - Gemini 3.1 Pro',
    provider: 'vertex',
    url: 'https://provider.example/v1',
    status: 200,
    success: true,
    aborted: false,
    route: 'proxy',
    streaming: true,
    durationMs: 22_400,
    firstTokenMs: 850,
    inputTokens: 6_537,
    outputTokens: 792,
    cachedTokens: 100,
    reasoningTokens: 40,
    injectionManifest: {
        totalTokens: 1_245,
        estimated: true,
        items: [
            { kind: 'systemPrompt', tokens: 16 },
            { kind: 'lorebook', name: '라비안', tokens: 226 },
            { kind: 'lorebook', name: 'Main', tokens: 1_003 },
        ],
    },
    requestBody: '{"apiKey":"must-not-export"}',
    responseBody: 'secret prose',
    truncated: false,
}

describe('chat request evidence', () => {
    it('builds exportable evidence for legacy plugin generations without stored rows', () => {
        const evidence = buildLegacyChatRequestEvidence('chat-legacy', [{
            timestamp: Date.UTC(2026, 7, 12, 3, 4, 5),
            generationId: 'generation-plugin',
            model: 'pluginmodel:::[PM] gemini-3.7-flash',
            inputTokens: 27_094,
            outputTokens: 1_361,
            durationMs: 15_088,
            wikiTokens: 420,
        }], Date.UTC(2026, 7, 12, 4))

        expect(evidence.requestCount).toBe(1)
        expect(evidence.requests[0]).toMatchObject({
            timestamp: '2026-08-12T03:04:05.000Z',
            generationId: 'generation-plugin',
            source: 'main',
            inputTokens: 27_094,
            outputTokens: 1_361,
        })
        expect(evidence.requests[0].injectionManifest).toEqual({
            totalTokens: 27_094,
            estimated: true,
            items: [
                { kind: 'wiki', name: '선택된 BardWiki', tokens: 420 },
                { kind: 'other', name: '세부 구성이 보존되지 않은 입력', tokens: 26_674 },
            ],
        })
    })

    it('keeps only evidence metadata and reconciles injection tokens to input usage', () => {
        const evidence = buildChatRequestEvidence('chat-7', [entry], Date.UTC(2026, 7, 12, 4))
        expect(evidence.requests).toHaveLength(1)
        expect(evidence.requests[0].injectionManifest?.totalTokens).toBe(6_537)
        expect(evidence.requests[0].injectionManifest?.items.reduce(
            (sum, item) => sum + item.tokens, 0
        )).toBe(6_537)
        expect(JSON.stringify(evidence)).not.toContain('must-not-export')
        expect(JSON.stringify(evidence)).not.toContain('secret prose')
        expect(JSON.stringify(evidence)).not.toContain('provider.example')
    })

    it('formats the card fields and every injection row as readable Markdown', () => {
        const evidence = buildChatRequestEvidence('chat-7', [entry], Date.UTC(2026, 7, 12, 4))
        const markdown = formatChatRequestEvidenceMarkdown(evidence)
        expect(markdown).toContain('Vertex AI - Gemini 3.1 Pro')
        expect(markdown).toContain('6,537')
        expect(markdown).toContain('792')
        expect(markdown).toContain('22.4초')
        expect(markdown).toContain('로어북 · 라비안')
        expect(markdown).toContain('로어북 · Main')
        expect(markdown).not.toContain('must-not-export')
        expect(markdown).not.toContain('secret prose')
    })

    it('estimates the no-wiki full-chat input only when the report is exported', async () => {
        const evidence = buildChatRequestEvidence('chat-7', [{
            ...entry,
            id: 1,
            generationId: 'assistant-1',
            inputTokens: 100,
            outputTokens: 10,
            injectionManifest: {
                totalTokens: 100,
                estimated: true,
                items: [
                    { kind: 'wiki', name: '현재 장면', tokens: 10 },
                    { kind: 'chatHistory', tokens: 20 },
                    { kind: 'other', tokens: 70 },
                ],
            },
        }, {
            ...entry,
            id: 2,
            generationId: 'assistant-2',
            inputTokens: 100,
            outputTokens: 10,
            injectionManifest: {
                totalTokens: 100,
                estimated: true,
                items: [
                    { kind: 'wiki', name: '선택 기억', tokens: 10 },
                    { kind: 'chatHistory', tokens: 20 },
                    { kind: 'other', tokens: 70 },
                ],
            },
        }, {
            ...entry,
            id: 3,
            source: 'memory',
            generationId: 'memory-2',
            inputTokens: 30,
            outputTokens: 5,
        }], Date.UTC(2026, 7, 12, 4))
        const countText = vi.fn(async (text: string) => text.length)
        const messages = [{
            role: 'user' as const,
            data: 'aaaa',
            chatId: 'user-1',
        }, {
            role: 'char' as const,
            data: 'bbbbbb',
            chatId: 'assistant-1',
            generationInfo: {
                generationId: 'assistant-1',
                risuBardContext: {
                    mode: 'current' as const,
                    recentMessages: [{ id: 'user-1', role: 'user' as const }],
                    wikiPaths: [],
                    selectedTokens: 10,
                    inquiryDurationMs: 0,
                },
            },
        }, {
            role: 'user' as const,
            data: 'ccc',
            chatId: 'user-2',
        }, {
            role: 'char' as const,
            data: 'reply',
            chatId: 'assistant-2',
            generationInfo: {
                generationId: 'assistant-2',
                risuBardContext: {
                    mode: 'current' as const,
                    recentMessages: [{ id: 'user-2', role: 'user' as const }],
                    wikiPaths: [],
                    selectedTokens: 10,
                    inquiryDurationMs: 0,
                },
            },
        }]

        const estimated = await addLegacyInputEstimates(evidence, messages, countText)

        expect(countText).toHaveBeenCalledTimes(4)
        expect(estimated.requests[0].legacyInput).toEqual({
            mode: 'estimated',
            activeMessageCount: 1,
            recentMessageCount: 1,
            fullChatTokens: 8,
            recentChatTokens: 8,
            removedWikiTokens: 10,
            inputTokens: 90,
        })
        expect(estimated.requests[1].legacyInput).toEqual({
            mode: 'estimated',
            activeMessageCount: 3,
            recentMessageCount: 1,
            fullChatTokens: 25,
            recentChatTokens: 7,
            removedWikiTokens: 10,
            inputTokens: 108,
        })
        expect(estimated.requests[2].legacyInput).toEqual({
            mode: 'excluded',
            inputTokens: 0,
        })
        expect(estimated.totals).toMatchObject({
            inputTokens: 230,
            legacyInputTokens: 198,
            inputTokenSavings: -32,
        })
        expect(estimated.totals.legacyInputSavingsRate).toBeCloseTo(-32 / 198)
    })

    it('prints legacy input composition without inventing legacy output tokens', async () => {
        const evidence = await addLegacyInputEstimates(
            buildChatRequestEvidence('chat-7', [entry], Date.UTC(2026, 7, 12, 4)),
            [{
                role: 'user', data: 'question', chatId: 'user-1',
            }, {
                role: 'char', data: 'answer', chatId: 'generation-7',
                generationInfo: {
                    generationId: 'generation-7',
                    risuBardContext: {
                        mode: 'current',
                        recentMessages: [{ id: 'user-1', role: 'user' }],
                        wikiPaths: [], selectedTokens: 0, inquiryDurationMs: 0,
                    },
                },
            }],
            async (text) => text.length,
        )

        const markdown = formatChatRequestEvidenceMarkdown(evidence)
        expect(markdown).toContain('총 입력 토큰 (가상 레거시)')
        expect(markdown).toContain('입력 토큰 절감량')
        expect(markdown).toContain('### 레거시 입력 구성')
        expect(markdown).toContain('전체 활성 메시지')
        expect(markdown).not.toContain('출력 토큰 (가상 레거시)')
    })
})
