import { describe, expect, it, vi } from 'vitest'
import {
    createNarrativeSourcesPrompt,
    createNarrativeInquiryShadow,
    createNarrativeInquiryShadowCache,
    createNarrativeContextPrompt,
    isNarrativeContextOptedIn,
    loadNarrativeInquiry,
    observeNarrativeInquiryShadow,
    ensureNarrativeSessionChatId,
    findNarrativeSessionChat,
    scheduleNarrativeInquiryShadow,
    selectPromptedNarrativeSources,
    normalizeNarrativeWorkingMessageLimit,
    selectNarrativeWorkingMessages,
    shouldIncludeNarrativeFirstMessage,
} from './narrativeContext'

describe('actual narrative inquiry prompt', () => {
    it('assigns one stable v2 session ID to an idless legacy chat', () => {
        const chat: { id?: string } = {}
        const createId = vi.fn(() => 'generated-chat-id')

        expect(ensureNarrativeSessionChatId(chat, createId))
            .toBe('generated-chat-id')
        expect(chat.id).toBe('generated-chat-id')
        expect(ensureNarrativeSessionChatId(chat, createId))
            .toBe('generated-chat-id')
        expect(createId).toHaveBeenCalledOnce()
    })

    it('resolves the captured v2 session after chat indexes change', () => {
        const captured = { id: 'captured-id', message: ['captured'] }
        const chats = [
            { id: 'other-id', message: ['other'] },
            captured,
        ]

        expect(findNarrativeSessionChat(chats, 'captured-id')).toBe(captured)
        expect(findNarrativeSessionChat(chats, 'missing-id')).toBeUndefined()
    })

    it('invokes browser fetch with the Window-compatible global receiver', async () => {
        const fetchImpl = function (
            this: unknown
        ): Promise<Response> {
            if (this !== globalThis) {
                throw new TypeError(
                    "'fetch' called on an object that does not implement interface Window."
                )
            }
            return Promise.resolve(new Response(JSON.stringify({
                mode: 'bounded-v1-fallback',
                graphRevision: 0,
                indexRevision: 0,
                cacheStatus: 'missing-or-stale',
                sources: [],
                entityCandidates: [],
                metrics: {
                    candidateCount: 0,
                    inspectedNodeCount: 0,
                    inspectedEdgeCount: 0,
                    selectedNodeCount: 0,
                    selectedTokens: 0,
                    hopCount: 0,
                    auxiliaryModelCalls: 0,
                },
            })))
        } as typeof fetch

        await expect(loadNarrativeInquiry({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'What happened?',
            fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toMatchObject({
            mode: 'bounded-v1-fallback',
            sources: [],
        })
    })

    it('enables current narrative memory by default unless explicitly disabled', () => {
        expect(isNarrativeContextOptedIn({
            getItem: () => null,
        })).toBe(true)
        expect(isNarrativeContextOptedIn({
            getItem: () => 'false',
        })).toBe(false)
        expect(isNarrativeContextOptedIn({
            getItem: () => 'true',
        })).toBe(true)
    })

    it('aborts a stalled local inquiry within its fixed timeout', async () => {
        const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'))
                })
            })) as unknown as typeof fetch

        await expect(loadNarrativeInquiry({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'What happened?',
            fetchImpl,
            createAuth: async () => 'auth',
            timeoutMs: 5,
        })).rejects.toMatchObject({
            name: 'AbortError',
            message: 'RisuBard narrative inquiry timed out after 5 ms',
        })
    })

    it('applies the inquiry deadline while authentication is stalled', async () => {
        await expect(loadNarrativeInquiry({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'What happened?',
            fetchImpl: vi.fn() as unknown as typeof fetch,
            createAuth: () => new Promise<string>(() => undefined),
            timeoutMs: 5,
        })).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('applies the inquiry deadline while the response body is stalled', async () => {
        const fetchImpl = vi.fn(async () => ({
            ok: true,
            status: 200,
            json: () => new Promise<unknown>(() => undefined),
        } as Response)) as unknown as typeof fetch

        await expect(loadNarrativeInquiry({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'What happened?',
            fetchImpl,
            createAuth: async () => 'auth',
            timeoutMs: 5,
        })).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('loads bounded server sources and serializes only selected content', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            mode: 'v2-current',
            graphRevision: 4,
            indexRevision: 4,
            cacheStatus: 'current',
            sources: [{
                id: 'narrative-memory:event:bridge',
                kind: 'memory',
                role: 'system',
                content: '[Event] The bridge collapsed.',
                tokens: 8,
                priority: 120,
            }],
            metrics: {
                candidateCount: 1,
                inspectedNodeCount: 1,
                inspectedEdgeCount: 0,
                selectedNodeCount: 1,
                selectedTokens: 8,
                hopCount: 1,
                auxiliaryModelCalls: 0,
            },
        }))) as unknown as typeof fetch

        const inquiry = await loadNarrativeInquiry({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'What happened?',
            tokenBudget: { target: 1_500, maximum: 4_500 },
            fetchImpl,
            createAuth: async () => 'auth',
        })
        const prompt = createNarrativeSourcesPrompt(
            inquiry.sources,
            'Lina is at the bridge.'
        )

        expect(prompt).toContain('Lina is at the bridge.')
        expect(prompt).toContain('narrative-memory:event:bridge')
        expect(prompt).toContain('[Event] The bridge collapsed.')
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/inquiry',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    characterId: 'character-1',
                    chatId: 'chat-1',
                    currentInput: 'What happened?',
                    tokenBudget: { target: 1_500, maximum: 4_500 },
                }),
            })
        )
    })

    it('accepts Markdown inquiry metrics above the retired v1 token budget', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            mode: 'v2-current',
            graphRevision: 7,
            indexRevision: 7,
            cacheStatus: 'current',
            sources: [],
            metrics: {
                candidateCount: 7,
                inspectedNodeCount: 7,
                inspectedEdgeCount: 0,
                selectedNodeCount: 6,
                selectedTokens: 1_147,
                hopCount: 0,
                auxiliaryModelCalls: 0,
            },
        }))) as unknown as typeof fetch

        await expect(loadNarrativeInquiry({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: '여섯 명의 구조 대상 정보를 분석한다.',
            fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toMatchObject({
            metrics: { selectedTokens: 1_147 },
        })
    })

    it('accepts progressive inquiry metrics for a large Markdown catalog', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            mode: 'v2-current',
            graphRevision: 2_000,
            indexRevision: 2_000,
            cacheStatus: 'current',
            sources: [],
            metrics: {
                candidateCount: 64,
                inspectedNodeCount: 2_000,
                inspectedEdgeCount: 128,
                selectedNodeCount: 3,
                selectedTokens: 450,
                hopCount: 2,
                auxiliaryModelCalls: 0,
            },
        }))) as unknown as typeof fetch

        await expect(loadNarrativeInquiry({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: '에아렌딜의 유리병은 어디서 얻었지?',
            fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toMatchObject({
            metrics: {
                inspectedNodeCount: 2_000,
                hopCount: 2,
            },
        })
    })

    it('caps source count and prompt bytes independently of graph size', () => {
        const sources = Array.from({ length: 20 }, (_, index) => ({
            id: `memory-${index}`,
            kind: 'memory' as const,
            role: 'system' as const,
            content: `Memory ${index} ${'x'.repeat(1_000)}`,
            tokens: 260,
            priority: 100 - index,
        }))

        const prompt = createNarrativeSourcesPrompt(sources, '', 4_096)

        expect(prompt.length).toBeLessThanOrEqual(4_096)
        expect(prompt).toContain('Memory 0')
        expect(prompt).not.toContain('Memory 16')
    })

    it('keeps a source identity when its content is truncated by the prompt budget', () => {
        const source = {
            id: 'narrative-memory:wiki:places/bridge.md',
            kind: 'memory' as const,
            role: 'system' as const,
            content: `Bridge details ${'x'.repeat(200)}`,
            tokens: 55,
            priority: 100,
        }
        const fullPrompt = createNarrativeSourcesPrompt([source], '')!
        const truncatedPrompt = createNarrativeSourcesPrompt(
            [source],
            '',
            fullPrompt.indexOf(source.content) + 20
        )!
        expect(selectPromptedNarrativeSources).toBeTypeOf('function')
        expect(selectPromptedNarrativeSources([source], truncatedPrompt))
            .toEqual([source])
        expect(truncatedPrompt).not.toContain(source.content)
    })
})

describe('createNarrativeContextPrompt', () => {
    it('uses only active facts and recent events within a fixed budget', () => {
        const prompt = createNarrativeContextPrompt({
            facts: [
                { id: 'old', text: 'Old', status: 'invalidated', evidence: [] },
                { id: 'current', text: 'Current fact', status: 'active', evidence: [] },
            ],
            events: Array.from({ length: 10 }, (_, index) => ({
                id: `event-${index}`,
                summary: `Event ${index}`,
                evidence: [],
            })),
            appliedOperationIds: [],
        }, 120)

        expect(prompt).toContain('Current fact')
        expect(prompt).not.toContain('Old')
        expect(prompt.length).toBeLessThanOrEqual(120)
    })

    it('returns null until current narrative memory exists', () => {
        expect(createNarrativeContextPrompt({
            facts: [],
            events: [],
            appliedOperationIds: [],
        }, 1_000)).toBeNull()
    })
})

describe('selectNarrativeWorkingMessages', () => {
    it('normalizes a user-configured full-message window', () => {
        expect(normalizeNarrativeWorkingMessageLimit(undefined)).toBe(12)
        expect(normalizeNarrativeWorkingMessageLimit(0)).toBe(12)
        expect(normalizeNarrativeWorkingMessageLimit(101)).toBe(12)
        expect(normalizeNarrativeWorkingMessageLimit(24)).toBe(24)
    })

    it('keeps legacy history unchanged and caps current mode to recent messages', () => {
        const messages = Array.from({ length: 20 }, (_, index) => ({
            id: `message-${index}`,
        }))

        expect(selectNarrativeWorkingMessages(
            messages,
            'legacy',
            12
        )).toEqual(messages)
        expect(selectNarrativeWorkingMessages(
            messages,
            'current',
            12
        )).toEqual(messages.slice(-12))
        expect(messages).toHaveLength(20)
    })

    it('can omit historical user turns while retaining the current user request', () => {
        const messages = [
            { id: 'user-1', role: 'user' },
            { id: 'assistant-1', role: 'char' },
            { id: 'user-2', role: 'user' },
            { id: 'assistant-2', role: 'char' },
            { id: 'user-current', role: 'user' },
        ]

        expect(selectNarrativeWorkingMessages(
            messages,
            'current',
            3,
            false
        ).map((message) => message.id)).toEqual([
            'assistant-1',
            'assistant-2',
            'user-current',
        ])
        expect(selectNarrativeWorkingMessages(
            messages,
            'legacy',
            3,
            false
        )).toEqual(messages)
    })

    it('counts eight as total slots and always retains the current user request', () => {
        const messages = Array.from({ length: 8 }, (_, index) => [
            { id: `user-${index + 1}`, role: 'user' },
            { id: `assistant-${index + 1}`, role: 'char' },
        ]).flat().concat({ id: 'user-current', role: 'user' })

        const withUsers = selectNarrativeWorkingMessages(
            messages, 'current', 8, true
        )
        expect(withUsers.filter((message) => message.role === 'user')).toHaveLength(4)
        expect(withUsers.filter((message) => message.role === 'char')).toHaveLength(4)

        const withoutHistoricalUsers = selectNarrativeWorkingMessages(
            messages, 'current', 8, false
        )
        expect(withoutHistoricalUsers.filter((message) => message.role === 'user'))
            .toEqual([{ id: 'user-current', role: 'user' }])
        expect(withoutHistoricalUsers.filter((message) => message.role === 'char'))
            .toHaveLength(7)
    })

    it('keeps the first greeting inside the current-mode message budget', () => {
        expect(shouldIncludeNarrativeFirstMessage('current', 11, 12)).toBe(true)
        expect(shouldIncludeNarrativeFirstMessage('current', 12, 12)).toBe(false)
        expect(shouldIncludeNarrativeFirstMessage('legacy', 20, 12)).toBe(true)
    })
})

describe('createNarrativeInquiryShadow', () => {
    it('projects v1 memory into bounded memory sources and body-free metrics', () => {
        const timestamps = [10, 13]
        const result = createNarrativeInquiryShadow({
            state: {
                facts: [{
                    id: 'trust',
                    text: 'Lina distrusts Kain.',
                    status: 'active',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'message-1',
                    }],
                }],
                events: [{
                    id: 'ambush',
                    summary: 'Kain was ambushed before the rendezvous.',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'message-2',
                    }],
                }],
                appliedOperationIds: [],
            },
            storyId: 'chat-1',
            branchId: 'main',
            currentInput: 'Why was Kain ambushed?',
            now: () => timestamps.shift() ?? 13,
        })

        expect(result.sources.map((source) => source.id)).toEqual([
            'narrative-memory:event:v1:ambush',
            'narrative-memory:claim:v1:trust',
        ])
        expect(result.sources.every((source) =>
            source.kind === 'memory' && source.role === 'system'
        )).toBe(true)
        expect(result.report).toEqual({
            availableV1FactCount: 1,
            availableV1EventCount: 1,
            v1FactWindowCount: 1,
            v1EventWindowCount: 1,
            selectedV1FactCount: 1,
            selectedV1EventCount: 1,
            omittedV1FactCount: 0,
            omittedV1EventCount: 0,
            cacheHit: false,
            candidateCount: 2,
            selectedNodeCount: 2,
            selectedNodeIds: [
                'event:v1:ambush',
                'claim:v1:trust',
            ],
            selectedTokens: expect.any(Number),
            hopCount: 1,
            auxiliaryModelCalls: 0,
            elapsedMs: 3,
        })
        expect(JSON.stringify(result.report)).not.toContain('ambushed')
        expect(JSON.stringify(result.report)).not.toContain('distrusts')
    })

    it('emits only the comparison report through the supplied observer', () => {
        const reports: unknown[] = []
        const sources = observeNarrativeInquiryShadow({
            state: {
                facts: [],
                events: [{
                    id: 'ambush',
                    summary: 'Kain was ambushed.',
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'message-2',
                    }],
                }],
                appliedOperationIds: [],
            },
            storyId: 'chat-1',
            branchId: 'main',
            currentInput: 'Kain',
            now: () => 1,
            observe: (report) => reports.push(report),
        })

        expect(sources).toHaveLength(1)
        expect(reports).toHaveLength(1)
        expect(JSON.stringify(reports)).not.toContain('Kain was ambushed')
    })

    it('schedules shadow traversal without blocking the request path', () => {
        const tasks: Array<() => void> = []
        const reports: Array<{ availableV1EventCount: number }> = []
        const state = {
            facts: [],
            events: [{
                id: 'ambush',
                summary: 'Kain was ambushed.',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-2',
                }],
            }],
            appliedOperationIds: [],
        }

        scheduleNarrativeInquiryShadow({
            state,
            storyId: 'chat-1',
            branchId: 'main',
            currentInput: 'Kain',
            now: () => 1,
            schedule: (task) => tasks.push(task),
            observe: (report) => reports.push(report),
        })
        expect(tasks).toHaveLength(1)
        expect(reports).toEqual([])
        tasks[0]()
        expect(reports).toEqual([expect.objectContaining({
            availableV1EventCount: 1,
        })])
    })

    it('bounds the v1 shadow window and reuses its revision index', () => {
        const state = {
            facts: Array.from({ length: 100 }, (_, index) => ({
                id: `fact-${index}`,
                text: `Fact ${index}`,
                status: 'active' as const,
                evidence: [{
                    chatId: 'chat-1',
                    messageId: `fact-message-${index}`,
                }],
            })),
            events: Array.from({ length: 100 }, (_, index) => ({
                id: `event-${index}`,
                summary: `Event ${index}`,
                evidence: [{
                    chatId: 'chat-1',
                    messageId: `event-message-${index}`,
                }],
            })),
            appliedOperationIds: ['revision-1'],
        }
        const cache = createNarrativeInquiryShadowCache()

        const first = createNarrativeInquiryShadow({
            state,
            storyId: 'chat-1',
            branchId: 'main',
            currentInput: 'Event 99',
            cache,
            now: () => 1,
        })
        const second = createNarrativeInquiryShadow({
            state: structuredClone(state),
            storyId: 'chat-1',
            branchId: 'main',
            currentInput: 'Event 99',
            cache,
            now: () => 1,
        })

        expect(first.report).toMatchObject({
            availableV1FactCount: 100,
            availableV1EventCount: 100,
            v1FactWindowCount: 32,
            v1EventWindowCount: 32,
            cacheHit: false,
        })
        expect(second.report.cacheHit).toBe(true)
        expect(cache.size()).toBe(1)
    })
})
