import { describe, expect, it, vi } from 'vitest'
import { createPluginRequestEvidenceRecorder } from './pluginRequestEvidence'

describe('plugin request evidence recorder', () => {
    it('records body-free per-chat evidence with locally counted output tokens', async () => {
        const record = vi.fn()
        const recorder = createPluginRequestEvidenceRecorder({
            startedAt: 1_000,
            source: 'wiki-admin',
            sessionChatId: 'chat-1',
            generationId: 'generation-1',
            model: 'pluginmodel:::gemini',
            provider: 'gemini',
            injectionManifest: {
                totalTokens: 31,
                estimated: true,
                items: [{ kind: 'wiki', tokens: 31 }],
            },
        }, {
            now: () => 1_250,
            countTokens: async (text) => text.length,
            record,
        })

        recorder.markFirstToken(1_100)
        await recorder.finish({ success: true, streaming: true, output: 'done' })

        expect(record).toHaveBeenCalledWith(expect.objectContaining({
            timestamp: 1_000,
            category: 'llm',
            source: 'wiki-admin',
            sessionChatId: 'chat-1',
            generationId: 'generation-1',
            inputTokens: 31,
            outputTokens: 4,
            firstTokenMs: 100,
            durationMs: 250,
            success: true,
            streaming: true,
        }))
        expect(JSON.stringify(record.mock.calls[0][0])).not.toContain('done')
    })
})
