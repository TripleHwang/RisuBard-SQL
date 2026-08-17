import type {
    NarrativeMemoryState,
} from '../../../packages/risubard-core/src/memoryDelta'
import type {
    ContextSource,
} from '../../../packages/risubard-core/src/contextCompiler'
import {
    adaptV1NarrativeMemory,
} from '../../../packages/risubard-core/src/narrativeGraph'
import {
    buildNarrativeIndex,
    normalizeNarrativeTerms,
    type NarrativeGraphIndex,
} from '../../../packages/risubard-core/src/narrativeIndex'
import {
    inquireNarrativeMemory,
    narrativeInquiryToContextSources,
} from '../../../packages/risubard-core/src/narrativeInquiry'
import { invokeBrowserFetch } from './browserFetch'
import { normalizeRisuBardInquiryTokenBudget } from './risuBardSettings'

export const NARRATIVE_CONTEXT_OPT_IN_KEY =
    'risubard.experimentalNarrativeContext'

export function ensureNarrativeSessionChatId(
    chat: { id?: string },
    createId: () => string
): string {
    if (typeof chat.id === 'string' && chat.id.trim().length > 0) {
        return chat.id
    }
    const id = createId().trim()
    if (id.length === 0) {
        throw new Error('Narrative session chat ID must not be empty')
    }
    chat.id = id
    return id
}

export function findNarrativeSessionChat<T extends { id?: string }>(
    chats: T[],
    capturedId: string
): T | undefined {
    return chats.find((chat) => chat.id === capturedId)
}

export interface NarrativeInquiryResponse {
    mode: 'v2-current' | 'bounded-v1-fallback'
    graphRevision: number
    indexRevision: number
    cacheStatus: 'current' | 'missing-or-stale'
    sources: ContextSource[]
    entityCandidates: Array<{ id: string, title: string }>
    metrics: {
        candidateCount: number
        inspectedNodeCount: number
        inspectedEdgeCount: number
        selectedNodeCount: number
        selectedTokens: number
        hopCount: number
        auxiliaryModelCalls: 0
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[]
): boolean {
    const actual = Object.keys(value)
    return actual.length === keys.length
        && actual.every((key) => keys.includes(key))
}

function boundedMetric(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value)
        || (value as number) < 0
        || (value as number) > maximum) {
        throw new Error(
            'RisuBard Memory Wiki 조회 응답에 잘못된 수치가 포함되어 있습니다.'
        )
    }
    return value as number
}

export async function loadNarrativeInquiry(input: {
    characterId: string
    chatId: string
    currentInput: string
    tokenBudget?: {
        target: number
        maximum: number
    }
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
    timeoutMs?: number
}): Promise<NarrativeInquiryResponse> {
    const timeoutMs = input.timeoutMs ?? 150
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1
        || timeoutMs > 10_000) {
        throw new Error('Invalid RisuBard narrative inquiry timeout')
    }
    const controller = new AbortController()
    const fetchImpl = input.fetchImpl
    let timeout: ReturnType<typeof setTimeout> | undefined
    let value: unknown
    try {
        value = await Promise.race([
            (async () => {
                const auth = await input.createAuth()
                const response = await invokeBrowserFetch(
                    fetchImpl,
                    '/api/risubard/memory/inquiry',
                    {
                        method: 'POST',
                        credentials: 'same-origin',
                        signal: controller.signal,
                        headers: {
                            'content-type': 'application/json',
                            'risu-auth': auth,
                        },
                        body: JSON.stringify({
                            characterId: input.characterId,
                            chatId: input.chatId,
                            currentInput: input.currentInput.slice(0, 4_096),
                            ...(input.tokenBudget === undefined
                                ? {}
                                : { tokenBudget:
                                    normalizeRisuBardInquiryTokenBudget(
                                        input.tokenBudget.target,
                                        input.tokenBudget.maximum
                                    ) }),
                        }),
                    }
                )
                if (!response.ok) {
                    throw new Error(
                        `RisuBard narrative inquiry failed with status ${response.status}`
                    )
                }
                return response.json()
            })(),
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => {
                    controller.abort()
                    reject(new DOMException(
                        `RisuBard narrative inquiry timed out after ${timeoutMs} ms`,
                        'AbortError'
                    ))
                }, timeoutMs)
            }),
        ])
    }
    finally {
        if (timeout !== undefined) clearTimeout(timeout)
    }
    if (!isRecord(value)
        || !(hasExactKeys(value, [
            'mode',
            'graphRevision',
            'indexRevision',
            'cacheStatus',
            'sources',
            'metrics',
        ]) || hasExactKeys(value, [
            'mode',
            'graphRevision',
            'indexRevision',
            'cacheStatus',
            'sources',
            'entityCandidates',
            'metrics',
        ]))
        || !['v2-current', 'bounded-v1-fallback'].includes(
            String(value.mode)
        )
        || !['current', 'missing-or-stale'].includes(
            String(value.cacheStatus)
        )
        || !Array.isArray(value.sources)
        || value.sources.length > 16
        || !isRecord(value.metrics)
        || !hasExactKeys(value.metrics, [
            'candidateCount',
            'inspectedNodeCount',
            'inspectedEdgeCount',
            'selectedNodeCount',
            'selectedTokens',
            'hopCount',
            'auxiliaryModelCalls',
        ])
        || (value.mode === 'v2-current'
            && value.cacheStatus !== 'current')
        || (value.mode === 'bounded-v1-fallback'
            && value.cacheStatus !== 'missing-or-stale')) {
        throw new Error(
            'RisuBard Memory Wiki 조회 응답이 현재 앱과 호환되지 않습니다. 앱과 서버를 다시 시작해 주세요.'
        )
    }
    const sources = value.sources.map((source): ContextSource => {
        if (!isRecord(source)
            || !(hasExactKeys(source, [
                'id',
                'kind',
                'role',
                'content',
                'tokens',
                'priority',
            ]) || hasExactKeys(source, [
                'id',
                'kind',
                'role',
                'content',
                'tokens',
                'priority',
                'occurredAt',
            ]))
            || typeof source.id !== 'string'
            || source.kind !== 'memory'
            || source.role !== 'system'
            || typeof source.content !== 'string'
            || source.content.length > 4_096) {
            throw new Error('Invalid RisuBard narrative inquiry source')
        }
        return {
            id: source.id,
            kind: 'memory',
            role: 'system',
            content: source.content,
            tokens: boundedMetric(source.tokens, 4_096),
            priority: boundedMetric(source.priority),
            ...(source.occurredAt === undefined
                ? {}
                : { occurredAt: boundedMetric(source.occurredAt) }),
        }
    })
    const entityCandidates = value.entityCandidates === undefined
        ? []
        : Array.isArray(value.entityCandidates)
            ? value.entityCandidates.slice(0, 16).map((candidate) => {
                if (!isRecord(candidate)
                    || !hasExactKeys(candidate, ['id', 'title'])
                    || typeof candidate.id !== 'string'
                    || typeof candidate.title !== 'string'
                    || candidate.id.trim().length === 0
                    || candidate.title.trim().length === 0) {
                    throw new Error(
                        'Invalid RisuBard narrative entity candidate'
                    )
                }
                return { id: candidate.id, title: candidate.title }
            })
            : (() => {
                throw new Error(
                    'Invalid RisuBard narrative entity candidates'
                )
            })()
    return {
        mode: value.mode as NarrativeInquiryResponse['mode'],
        graphRevision: boundedMetric(value.graphRevision),
        indexRevision: boundedMetric(value.indexRevision),
        cacheStatus: value.cacheStatus as NarrativeInquiryResponse['cacheStatus'],
        sources,
        entityCandidates,
        metrics: {
            candidateCount: boundedMetric(value.metrics.candidateCount, 64),
            inspectedNodeCount: boundedMetric(
                value.metrics.inspectedNodeCount,
                100_000
            ),
            inspectedEdgeCount: boundedMetric(
                value.metrics.inspectedEdgeCount,
                512
            ),
            selectedNodeCount: boundedMetric(
                value.metrics.selectedNodeCount,
                16
            ),
            selectedTokens: boundedMetric(
                value.metrics.selectedTokens
            ),
            hopCount: boundedMetric(value.metrics.hopCount, 2),
            auxiliaryModelCalls: 0,
        },
    }
}

export function createNarrativeSourcesPrompt(
    sources: readonly ContextSource[],
    baseline = '',
    characterBudget = 12_000
): string | null {
    const sections = [
        baseline.trim().length > 0
            ? `Current narrative baseline:\n${baseline.trim()}`
            : '',
        sources.slice(0, 16).length > 0
            ? `Relevant narrative memory:\n${sources.slice(0, 16)
                .map((source) =>
                    `- [source ${JSON.stringify(source.id)}] ${source.content}`
                )
                .join('\n')}`
            : '',
    ].filter(Boolean)
    if (sections.length === 0) return null
    return sections.join('\n\n').slice(
        0,
        Math.max(0, characterBudget)
    )
}

export function selectPromptedNarrativeSources(
    sources: readonly ContextSource[],
    prompt: string
): ContextSource[] {
    return sources.slice(0, 16).filter((source) =>
        prompt.includes(`[source ${JSON.stringify(source.id)}]`)
    )
}

export interface NarrativeInquiryShadowReport {
    availableV1FactCount: number
    availableV1EventCount: number
    v1FactWindowCount: number
    v1EventWindowCount: number
    selectedV1FactCount: number
    selectedV1EventCount: number
    omittedV1FactCount: number
    omittedV1EventCount: number
    cacheHit: boolean
    candidateCount: number
    selectedNodeCount: number
    selectedNodeIds: string[]
    selectedTokens: number
    hopCount: number
    auxiliaryModelCalls: 0
    elapsedMs: number
}

export interface NarrativeInquiryShadowCache {
    resolve(
        key: string,
        create: () => NarrativeGraphIndex
    ): { index: NarrativeGraphIndex, cacheHit: boolean }
    size(): number
}

export function createNarrativeInquiryShadowCache(
    maxEntries = 32
): NarrativeInquiryShadowCache {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
        throw new Error('Shadow cache size must be positive')
    }
    const entries = new Map<string, NarrativeGraphIndex>()
    return {
        resolve(key, create) {
            const found = entries.get(key)
            if (found) {
                entries.delete(key)
                entries.set(key, found)
                return { index: found, cacheHit: true }
            }
            const index = create()
            entries.set(key, index)
            while (entries.size > maxEntries) {
                const oldest = entries.keys().next().value
                if (oldest === undefined) break
                entries.delete(oldest)
            }
            return { index, cacheHit: false }
        },
        size: () => entries.size,
    }
}

export const runtimeNarrativeInquiryShadowCache =
    createNarrativeInquiryShadowCache()

function v1RevisionKey(
    state: NarrativeMemoryState,
    storyId: string,
    branchId: string
): string {
    const lastFact = state.facts.at(-1)
    const lastEvent = state.events.at(-1)
    return JSON.stringify([
        storyId,
        branchId,
        state.facts.length,
        lastFact?.id ?? '',
        lastFact?.status ?? '',
        state.events.length,
        lastEvent?.id ?? '',
        state.appliedOperationIds.length,
        state.appliedOperationIds.at(-1) ?? '',
    ])
}

export function createNarrativeInquiryShadow(input: {
    state: NarrativeMemoryState
    storyId: string
    branchId: string
    currentInput: string
    now?: () => number
    cache?: NarrativeInquiryShadowCache
}): {
    sources: ContextSource[]
    report: NarrativeInquiryShadowReport
} {
    const now = input.now ?? performance.now.bind(performance)
    const startedAt = now()
    const factWindow = input.state.facts.slice(-32)
    const eventWindow = input.state.events.slice(-32)
    const boundedState: NarrativeMemoryState = {
        facts: factWindow,
        events: eventWindow,
        appliedOperationIds: [],
    }
    const createIndex = () => buildNarrativeIndex(adaptV1NarrativeMemory({
        state: boundedState,
        storyId: input.storyId,
        branchId: input.branchId,
    }))
    const resolved = input.cache?.resolve(
        v1RevisionKey(input.state, input.storyId, input.branchId),
        createIndex
    ) ?? { index: createIndex(), cacheHit: false }
    const terms = normalizeNarrativeTerms(
        input.currentInput.slice(0, 4_096)
    ).slice(0, 32).map((term) => term.slice(0, 64))
    const inquiry = inquireNarrativeMemory(resolved.index, {
        entityIds: [],
        openThreadIds: [],
        terms,
        tokenBudget: 512,
        maxSelectedNodes: 16,
    })
    const v1FactWindowCount = factWindow.filter(
        (fact) => fact.status === 'active'
    ).length
    const v1EventWindowCount = eventWindow.length
    const selectedV1FactCount = inquiry.selected.filter(
        (item) => item.node.id.startsWith('claim:v1:')
    ).length
    const selectedV1EventCount = inquiry.selected.filter(
        (item) => item.node.id.startsWith('event:v1:')
    ).length
    return {
        sources: narrativeInquiryToContextSources(inquiry),
        report: {
            availableV1FactCount: input.state.facts.length,
            availableV1EventCount: input.state.events.length,
            v1FactWindowCount,
            v1EventWindowCount,
            selectedV1FactCount,
            selectedV1EventCount,
            omittedV1FactCount: Math.max(
                0,
                v1FactWindowCount - selectedV1FactCount
            ),
            omittedV1EventCount: Math.max(
                0,
                v1EventWindowCount - selectedV1EventCount
            ),
            cacheHit: resolved.cacheHit,
            candidateCount: inquiry.metrics.candidateCount,
            selectedNodeCount: inquiry.metrics.selectedNodeCount,
            selectedNodeIds: inquiry.selected.map((item) => item.node.id),
            selectedTokens: inquiry.metrics.selectedTokens,
            hopCount: inquiry.metrics.hopCount,
            auxiliaryModelCalls: inquiry.metrics.auxiliaryModelCalls,
            elapsedMs: Math.max(0, now() - startedAt),
        },
    }
}

export function observeNarrativeInquiryShadow(input: {
    state: NarrativeMemoryState
    storyId: string
    branchId: string
    currentInput: string
    now?: () => number
    cache?: NarrativeInquiryShadowCache
    observe(report: NarrativeInquiryShadowReport): void
}): ContextSource[] {
    const result = createNarrativeInquiryShadow(input)
    input.observe(result.report)
    return result.sources
}

export function scheduleNarrativeInquiryShadow(input: {
    state: NarrativeMemoryState
    storyId: string
    branchId: string
    currentInput: string
    now?: () => number
    cache?: NarrativeInquiryShadowCache
    schedule(task: () => void): void
    observe(report: NarrativeInquiryShadowReport): void
    onError?(error: unknown): void
}): void {
    input.schedule(() => {
        try {
            observeNarrativeInquiryShadow({
                state: input.state,
                storyId: input.storyId,
                branchId: input.branchId,
                currentInput: input.currentInput,
                now: input.now,
                cache: input.cache,
                observe: input.observe,
            })
        }
        catch (error) {
            input.onError?.(error)
        }
    })
}

export function isNarrativeContextOptedIn(storage: Pick<
    Storage,
    'getItem'
> = localStorage): boolean {
    return storage.getItem(NARRATIVE_CONTEXT_OPT_IN_KEY) !== 'false'
}

export function createNarrativeContextPrompt(
    state: NarrativeMemoryState,
    characterBudget = 12_000,
    baseline = ''
): string | null {
    const activeFacts = state.facts
        .filter((fact) => fact.status === 'active')
        .map((fact) => `- ${fact.text}`)
    const recentEvents = state.events
        .slice(-8)
        .map((event) => `- ${event.summary}`)
    if (baseline.trim().length === 0
        && activeFacts.length === 0
        && recentEvents.length === 0) return null

    const sections = [
        activeFacts.length > 0
            ? `Current facts:\n${activeFacts.join('\n')}`
            : '',
        recentEvents.length > 0
            ? `Recent events:\n${recentEvents.join('\n')}`
            : '',
        baseline.trim().length > 0
            ? `Current narrative baseline:\n${baseline}`
            : '',
    ].filter(Boolean)
    return sections.join('\n\n').slice(0, Math.max(0, characterBudget))
}

export function selectNarrativeWorkingMessages<T>(
    messages: readonly T[],
    mode: 'legacy' | 'current',
    limit = 12,
    includeHistoricalUserMessages = true
): T[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('Narrative working-message limit must be positive')
    }
    if (mode === 'legacy') return [...messages]
    if (includeHistoricalUserMessages) return messages.slice(-limit)
    const roleOf = (message: T): unknown =>
        typeof message === 'object'
        && message !== null
        && 'role' in message
            ? (message as { role?: unknown }).role
            : undefined
    let latestUserIndex = -1
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (roleOf(messages[index]) === 'user') {
            latestUserIndex = index
            break
        }
    }
    return messages.filter((message, index) =>
        roleOf(message) !== 'user' || index === latestUserIndex
    ).slice(-limit)
}

export function normalizeNarrativeWorkingMessageLimit(
    value: unknown,
    fallback = 12
): number {
    return Number.isSafeInteger(value)
        && (value as number) >= 1
        && (value as number) <= 100
        ? value as number
        : fallback
}

export function shouldIncludeNarrativeFirstMessage(
    mode: 'legacy' | 'current',
    availableHistoryMessages: number,
    limit = 12
): boolean {
    return mode === 'legacy' || availableHistoryMessages < limit
}
