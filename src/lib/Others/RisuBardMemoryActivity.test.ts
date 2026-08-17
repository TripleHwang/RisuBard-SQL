// @vitest-environment happy-dom
import { mount, tick, unmount } from 'svelte'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    loadChatRequestEvidence: vi.fn(),
    addLegacyInputEstimates: vi.fn(async (evidence: unknown) => evidence),
    downloadFile: vi.fn(),
}))

vi.mock('src/ts/risubard/chatRequestEvidence', () => ({
    loadChatRequestEvidence: mocks.loadChatRequestEvidence,
    addLegacyInputEstimates: mocks.addLegacyInputEstimates,
    formatChatRequestEvidenceMarkdown: vi.fn(() => '# evidence'),
    buildLegacyChatRequestEvidence: vi.fn((chatId: string, entries: unknown[]) => ({
        schemaVersion: 1,
        generatedAt: '2026-08-12T04:00:00.000Z',
        chatId,
        requestCount: entries.length,
        totals: { inputTokens: 10, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0 },
        requests: entries.map((entry: any, index: number) => ({
            id: -(index + 1),
            timestamp: new Date(entry.timestamp).toISOString(),
            generationId: entry.generationId,
            source: 'main',
            model: entry.model,
            outcome: 'done',
            streaming: false,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
        })),
    })),
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    downloadFile: mocks.downloadFile,
}))
import RisuBardMemoryActivity from './RisuBardMemoryActivity.svelte'
import { publishRisuBardMemoryActivity } from 'src/ts/risubard/memoryActivity'

let mounted: ReturnType<typeof mount> | undefined

beforeEach(() => {
    mocks.loadChatRequestEvidence.mockResolvedValue({
        schemaVersion: 1,
        generatedAt: '2026-08-12T04:00:00.000Z',
        chatId: 'chat',
        requestCount: 0,
        totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
        requests: [],
    })
})

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.clearAllMocks()
})

describe('RisuBardMemoryActivity', () => {
    it('uses the full log pane instead of a fixed 18rem stream', () => {
        const source = readFileSync(resolve(
            process.cwd(), 'src/lib/Others/RisuBardMemoryActivity.svelte'
        ), 'utf8')
        expect(source).toMatch(/\.activity-console\s*\{[^}]*height:\s*100%/s)
        expect(source).toMatch(/\.activity-stream\s*\{[^}]*flex:\s*1/s)
        expect(source).not.toMatch(/\.activity-stream\s*\{[^}]*max-height:/s)
    })

    it('shows a failure published before the log view mounts', async () => {
        publishRisuBardMemoryActivity({
            characterId: 'late-character',
            chatId: 'late-chat',
            operation: 'error',
            timestamp: 123,
            message: '위키 조회 제한 시간을 초과했습니다.',
        })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryActivity, {
            target,
            props: {
                characterId: 'late-character',
                chatId: 'late-chat',
                messages: [],
            },
        })
        await tick()

        expect(document.body.textContent).toContain(
            '위키 조회 제한 시간을 초과했습니다.'
        )
    })

    it('shows per-generation chat and wiki provenance without prompt bodies', async () => {
        mocks.loadChatRequestEvidence.mockResolvedValue({
            schemaVersion: 1,
            generatedAt: '2026-08-12T04:00:00.000Z',
            chatId: 'chat',
            requestCount: 0,
            totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
            requests: [],
        })
        const onSelectPath = vi.fn()
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryActivity, {
            target,
            props: {
                characterId: 'character',
                chatId: 'chat',
                messages: [{
                    role: 'char',
                    data: 'secret generated prose',
                    chatId: 'assistant-2',
                    time: Date.UTC(2026, 7, 12, 3, 4, 5),
                    generationInfo: {
                        generationId: 'generation-2',
                        model: 'deepseek-v4-flash',
                        inputTokens: 2841,
                        outputTokens: 617,
                        toolUsed: false,
                        stageTiming: { stage1: 10, stage2: 20, stage3: 3000, stage4: 30 },
                        risuBardContext: {
                            mode: 'current',
                            recentMessages: [{ id: 'user-1', role: 'user' }],
                            wikiPaths: ['characters/라비안.md'],
                            selectedTokens: 210,
                            inquiryDurationMs: 18,
                        },
                    },
                }],
                onSelectPath,
            },
        })
        await tick()

        expect(document.body.textContent).toContain('deepseek-v4-flash')
        expect(document.body.textContent).toContain('답변 생성')
        expect(document.querySelector('time')?.dateTime).toBe(
            '2026-08-12T03:04:05.000Z'
        )
        expect(document.body.textContent).toContain('2,841')
        expect(document.body.textContent).toContain('617')
        expect(document.body.textContent).toContain('user-1')
        expect(document.body.textContent).not.toContain('secret generated prose')
        const path = [...document.querySelectorAll('button')].find((button) =>
            button.textContent?.includes('characters/라비안.md'))!
        path.click()
        expect(onSelectPath).toHaveBeenCalledWith('characters/라비안.md')
    })

    it('labels persisted automatic wiki and administrator requests', async () => {
        mocks.loadChatRequestEvidence.mockResolvedValue({
            schemaVersion: 1,
            generatedAt: '2026-08-12T04:00:00.000Z',
            chatId: 'chat-kinds',
            requestCount: 2,
            totals: { inputTokens: 30, outputTokens: 8, cachedTokens: 0, reasoningTokens: 0 },
            requests: [{
                id: 2,
                timestamp: '2026-08-12T03:05:00.000Z',
                generationId: 'wiki-2',
                source: 'memory',
                outcome: 'done',
                streaming: false,
                inputTokens: 20,
                outputTokens: 5,
            }, {
                id: 1,
                timestamp: '2026-08-12T03:04:00.000Z',
                generationId: 'admin-1',
                source: 'wiki-admin',
                outcome: 'done',
                streaming: false,
                inputTokens: 10,
                outputTokens: 3,
            }],
        })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryActivity, {
            target,
            props: { characterId: 'character', chatId: 'chat-kinds', messages: [] },
        })

        await vi.waitFor(() => {
            expect(document.body.textContent).toContain('위키 작업')
            expect(document.body.textContent).toContain('위키 관리자 명령')
        })
        expect([...document.querySelectorAll('time')].map((node) => node.dateTime))
            .toEqual([
                '2026-08-12T03:05:00.000Z',
                '2026-08-12T03:04:00.000Z',
            ])
    })

    it('renders nullable database metrics as unavailable', async () => {
        mocks.loadChatRequestEvidence.mockResolvedValue({
            schemaVersion: 1,
            generatedAt: '2026-08-12T04:00:00.000Z',
            chatId: 'chat-null-metrics',
            requestCount: 1,
            totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
            requests: [{
                id: 1,
                timestamp: '2026-08-12T03:04:00.000Z',
                source: 'main',
                outcome: 'done',
                streaming: false,
                inputTokens: null,
                outputTokens: null,
                durationMs: null,
                firstTokenMs: null,
            }],
        })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryActivity, {
            target,
            props: { characterId: 'character', chatId: 'chat-null-metrics', messages: [] },
        })

        await vi.waitFor(() => {
            expect(document.body.textContent).toContain('답변 생성')
            expect(document.body.textContent).toContain('입력 확인 불가')
            expect(document.body.textContent).toContain('첫 응답 확인 불가 ms')
        })
    })

    it('exports the current chat request evidence as Markdown or JSON', async () => {
        mocks.loadChatRequestEvidence.mockResolvedValue({
            schemaVersion: 1,
            generatedAt: '2026-08-12T04:00:00.000Z',
            chatId: 'chat-evidence',
            requestCount: 1,
            totals: { inputTokens: 6537, outputTokens: 792, cachedTokens: 0, reasoningTokens: 0 },
            requests: [],
        })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryActivity, {
            target,
            props: {
                characterId: 'character',
                chatId: 'chat-evidence',
                messages: [],
            },
        })
        await tick()

        const markdown = document.body.querySelector<HTMLButtonElement>(
            '[data-export-request-evidence="markdown"]'
        )
        const json = document.body.querySelector<HTMLButtonElement>(
            '[data-export-request-evidence="json"]'
        )
        expect(markdown).not.toBeNull()
        expect(json).not.toBeNull()

        json?.click()
        await vi.waitFor(() => {
            expect(mocks.loadChatRequestEvidence).toHaveBeenCalledWith('chat-evidence')
            expect(mocks.addLegacyInputEstimates).toHaveBeenCalledWith(
                expect.objectContaining({ chatId: 'chat-evidence' }),
                [],
            )
            expect(mocks.downloadFile).toHaveBeenCalledWith(
                expect.stringMatching(/^risubard-chat-evidence-.*\.json$/),
                expect.stringContaining('"inputTokens": 6537'),
            )
        })
        markdown?.click()
        await vi.waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledWith(
            expect.stringMatching(/^risubard-chat-evidence-.*\.md$/),
            '# evidence',
        ))
    })

    it('exports legacy generation evidence when no persisted plugin row exists', async () => {
        mocks.loadChatRequestEvidence.mockResolvedValue({
            schemaVersion: 1,
            generatedAt: '2026-08-12T04:00:00.000Z',
            chatId: 'chat-legacy',
            requestCount: 0,
            totals: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
            requests: [],
        })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryActivity, {
            target,
            props: {
                characterId: 'character',
                chatId: 'chat-legacy',
                messages: [{
                    role: 'char', data: 'hidden', chatId: 'generation-1',
                    time: Date.UTC(2026, 7, 12, 3),
                    generationInfo: {
                        model: 'pluginmodel:::gemini', inputTokens: 10, outputTokens: 2,
                        risuBardContext: {
                            mode: 'current', recentMessages: [], wikiPaths: [],
                            selectedTokens: 0, inquiryDurationMs: 0,
                        },
                    },
                }],
            },
        })
        await tick()
        document.body.querySelector<HTMLButtonElement>(
            '[data-export-request-evidence="json"]'
        )?.click()

        await vi.waitFor(() => expect(mocks.downloadFile).toHaveBeenCalledWith(
            expect.stringMatching(/\.json$/),
            expect.stringContaining('"requestCount": 1'),
        ))
        expect(document.body.textContent).not.toContain('저장된 요청 증거가 없습니다')
    })
})
