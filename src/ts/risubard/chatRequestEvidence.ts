import {
    fetchRequestLogPage,
    type RequestLogEntry,
    type RequestLogRoute,
    type RequestLogSource,
} from 'src/ts/requestLog'
import {
    reconcileInjectionManifest,
    type RequestInjectionKind,
    type RequestInjectionManifest,
} from 'src/ts/status/requestStatus'
import type { Message } from 'src/ts/storage/database.svelte'

export interface LegacyInputComposition {
    mode: 'estimated' | 'excluded' | 'unchanged' | 'unavailable'
    inputTokens?: number
    activeMessageCount?: number
    recentMessageCount?: number
    fullChatTokens?: number
    recentChatTokens?: number
    removedWikiTokens?: number
}

export interface ChatRequestEvidenceEntry {
    id: number
    timestamp: string
    generationId?: string
    source: RequestLogSource
    model?: string
    provider?: string
    outcome: 'done' | 'failed' | 'aborted'
    status?: number
    route?: RequestLogRoute
    streaming: boolean
    durationMs?: number
    firstTokenMs?: number
    inputTokens?: number
    outputTokens?: number
    cachedTokens?: number
    reasoningTokens?: number
    injectionManifest?: RequestInjectionManifest
    legacyInput?: LegacyInputComposition
}

export interface ChatRequestEvidence {
    schemaVersion: 1
    generatedAt: string
    chatId: string
    requestCount: number
    totals: {
        inputTokens: number
        outputTokens: number
        cachedTokens: number
        reasoningTokens: number
        legacyInputTokens?: number
        inputTokenSavings?: number
        legacyInputSavingsRate?: number
    }
    requests: ChatRequestEvidenceEntry[]
}

export interface LegacyChatGenerationEvidence {
    timestamp?: number
    generationId?: string
    model?: string
    inputTokens?: number
    outputTokens?: number
    durationMs?: number
    wikiTokens?: number
}

const injectionLabels: Record<RequestInjectionKind, string> = {
    systemPrompt: '주입 컨텍스트',
    jailbreak: '탈옥 프롬프트',
    globalNote: '전역 메모',
    authorNote: '작가 노트',
    character: '캐릭터',
    persona: '페르소나',
    lorebook: '로어북',
    wiki: 'BardWiki',
    memory: '메모리',
    exampleDialogue: '예시 대화',
    chatHistory: '채팅 기록',
    instruction: '추가 지침',
    tool: '도구',
    other: '기타',
}

const number = (value: number | undefined) => value?.toLocaleString('ko-KR') ?? '확인 불가'

function sum(entries: RequestLogEntry[], key: 'inputTokens' | 'outputTokens' | 'cachedTokens' | 'reasoningTokens') {
    return entries.reduce((total, entry) => total + Math.max(0, entry[key] ?? 0), 0)
}

const legacyMessageOverheadTokens = 4

async function countLegacyTextTokens(text: string): Promise<number> {
    const { encodeWithTokenizer } = await import('src/ts/tokenizer')
    return (await encodeWithTokenizer(text, 'tik')).length
}

function messageId(message: Message): string | undefined {
    return message.chatId ?? message.generationInfo?.generationId
}

function activeMessagesBefore(messages: readonly Message[], end: number): Message[] {
    const active: Message[] = []
    for (let index = end - 1; index >= 0; index--) {
        const message = messages[index]
        if (message.disabled === true || message.isComment) continue
        if (message.disabled === 'allBefore') break
        active.unshift(message)
    }
    return active
}

function isWikiOnlyRequest(source: RequestLogSource): boolean {
    return source === 'memory' || source === 'wiki-admin'
}

/**
 * Adds a no-wiki/full-chat counterfactual when evidence is exported. Message
 * bodies are tokenized once locally; this never runs in the generation path.
 */
export async function addLegacyInputEstimates(
    evidence: ChatRequestEvidence,
    messages: readonly Message[],
    countText: (text: string) => Promise<number> = countLegacyTextTokens,
): Promise<ChatRequestEvidence> {
    const messageTokens = new Map<Message, number>()
    for (const message of messages) {
        const tokens = await countText(message.data)
        messageTokens.set(message, Math.max(0, Math.round(tokens)) + legacyMessageOverheadTokens)
    }

    const requests = evidence.requests.map((request): ChatRequestEvidenceEntry => {
        if (isWikiOnlyRequest(request.source)) {
            return { ...request, legacyInput: { mode: 'excluded', inputTokens: 0 } }
        }
        if (request.source !== 'main') {
            return {
                ...request,
                legacyInput: request.inputTokens === undefined
                    ? { mode: 'unavailable' }
                    : { mode: 'unchanged', inputTokens: request.inputTokens },
            }
        }
        const assistantIndex = messages.findIndex((message) =>
            message.role === 'char'
            && request.generationId !== undefined
            && (message.chatId === request.generationId
                || message.generationInfo?.generationId === request.generationId)
        )
        if (assistantIndex < 0 || request.inputTokens === undefined) {
            return { ...request, legacyInput: { mode: 'unavailable' } }
        }
        const assistant = messages[assistantIndex]
        const active = activeMessagesBefore(messages, assistantIndex)
        const recentIds = new Set(
            assistant.generationInfo?.risuBardContext?.recentMessages.map(
                (message) => message.id
            ) ?? []
        )
        const recent = active.filter((message) => {
            const id = messageId(message)
            return id !== undefined && recentIds.has(id)
        })
        const total = (items: readonly Message[]) => items.reduce(
            (sum, message) => sum + (messageTokens.get(message) ?? 0),
            0
        )
        const fullChatTokens = total(active)
        const recentChatTokens = total(recent)
        const manifestWikiTokens = request.injectionManifest?.items.reduce(
            (sum, item) => sum + (item.kind === 'wiki' ? Math.max(0, item.tokens) : 0),
            0
        )
        const removedWikiTokens = Math.round(manifestWikiTokens && manifestWikiTokens > 0
            ? manifestWikiTokens
            : assistant.generationInfo?.risuBardContext?.selectedTokens ?? 0)
        const inputTokens = Math.max(
            0,
            request.inputTokens - removedWikiTokens
                + Math.max(0, fullChatTokens - recentChatTokens)
        )
        return {
            ...request,
            legacyInput: {
                mode: 'estimated',
                activeMessageCount: active.length,
                recentMessageCount: recent.length,
                fullChatTokens,
                recentChatTokens,
                removedWikiTokens,
                inputTokens,
            },
        }
    })
    const complete = requests.every((request) => request.legacyInput?.inputTokens !== undefined)
    const legacyInputTokens = complete
        ? requests.reduce((total, request) => total + request.legacyInput!.inputTokens!, 0)
        : undefined
    const inputTokenSavings = legacyInputTokens === undefined
        ? undefined
        : legacyInputTokens - evidence.totals.inputTokens
    return {
        ...evidence,
        totals: {
            ...evidence.totals,
            ...(legacyInputTokens === undefined ? {} : {
                legacyInputTokens,
                inputTokenSavings,
                legacyInputSavingsRate: legacyInputTokens > 0
                    ? inputTokenSavings! / legacyInputTokens
                    : 0,
            }),
        },
        requests,
    }
}

export function buildChatRequestEvidence(
    chatId: string,
    entries: RequestLogEntry[],
    generatedAt = Date.now(),
): ChatRequestEvidence {
    const requests = entries.map((entry): ChatRequestEvidenceEntry => ({
        id: entry.id,
        timestamp: new Date(entry.timestamp).toISOString(),
        ...(entry.generationId || (entry.source === 'main' && entry.chatId)
            ? { generationId: entry.generationId ?? entry.chatId }
            : {}),
        source: entry.source,
        ...(entry.model ? { model: entry.model } : {}),
        ...(entry.provider ? { provider: entry.provider } : {}),
        outcome: entry.aborted ? 'aborted' : entry.success ? 'done' : 'failed',
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        ...(entry.route ? { route: entry.route } : {}),
        streaming: entry.streaming,
        ...(entry.durationMs !== undefined ? { durationMs: entry.durationMs } : {}),
        ...(entry.firstTokenMs !== undefined ? { firstTokenMs: entry.firstTokenMs } : {}),
        ...(entry.inputTokens !== undefined ? { inputTokens: entry.inputTokens } : {}),
        ...(entry.outputTokens !== undefined ? { outputTokens: entry.outputTokens } : {}),
        ...(entry.cachedTokens !== undefined ? { cachedTokens: entry.cachedTokens } : {}),
        ...(entry.reasoningTokens !== undefined ? { reasoningTokens: entry.reasoningTokens } : {}),
        ...(entry.injectionManifest ? {
            injectionManifest: reconcileInjectionManifest(
                entry.injectionManifest,
                entry.inputTokens,
            ),
        } : {}),
    }))
    return {
        schemaVersion: 1,
        generatedAt: new Date(generatedAt).toISOString(),
        chatId,
        requestCount: requests.length,
        totals: {
            inputTokens: sum(entries, 'inputTokens'),
            outputTokens: sum(entries, 'outputTokens'),
            cachedTokens: sum(entries, 'cachedTokens'),
            reasoningTokens: sum(entries, 'reasoningTokens'),
        },
        requests,
    }
}

/**
 * Older/plugin generations predate persisted request rows. Keep their
 * body-free message metadata exportable while stating that the detailed
 * input composition was not retained.
 */
export function buildLegacyChatRequestEvidence(
    chatId: string,
    entries: LegacyChatGenerationEvidence[],
    generatedAt = Date.now(),
): ChatRequestEvidence {
    const requests: ChatRequestEvidenceEntry[] = entries.map((entry, index) => {
        const inputTokens = entry.inputTokens === undefined
            ? undefined
            : Math.max(0, Math.round(entry.inputTokens))
        const wikiTokens = Math.min(
            inputTokens ?? 0,
            Math.max(0, Math.round(entry.wikiTokens ?? 0)),
        )
        const items: RequestInjectionManifest['items'] = []
        if (wikiTokens > 0) {
            items.push({
                kind: 'wiki',
                name: '선택된 BardWiki',
                tokens: wikiTokens,
            })
        }
        if (inputTokens !== undefined && inputTokens - wikiTokens > 0) {
            items.push({
                kind: 'other',
                name: '세부 구성이 보존되지 않은 입력',
                tokens: inputTokens - wikiTokens,
            })
        }
        return {
            id: -(index + 1),
            timestamp: new Date(entry.timestamp ?? generatedAt).toISOString(),
            ...(entry.generationId ? { generationId: entry.generationId } : {}),
            source: 'main',
            ...(entry.model ? { model: entry.model } : {}),
            outcome: 'done',
            streaming: false,
            ...(entry.durationMs !== undefined
                ? { durationMs: Math.max(0, Math.round(entry.durationMs)) }
                : {}),
            ...(inputTokens !== undefined ? { inputTokens } : {}),
            ...(entry.outputTokens !== undefined ? {
                outputTokens: Math.max(0, Math.round(entry.outputTokens)),
            } : {}),
            ...(inputTokens !== undefined ? {
                injectionManifest: {
                    totalTokens: inputTokens,
                    estimated: true,
                    items,
                },
            } : {}),
        }
    })
    return {
        schemaVersion: 1,
        generatedAt: new Date(generatedAt).toISOString(),
        chatId,
        requestCount: requests.length,
        totals: {
            inputTokens: requests.reduce((sum, entry) => sum + (entry.inputTokens ?? 0), 0),
            outputTokens: requests.reduce((sum, entry) => sum + (entry.outputTokens ?? 0), 0),
            cachedTokens: 0,
            reasoningTokens: 0,
        },
        requests,
    }
}

function durationLabel(ms: number | undefined): string {
    if (ms === undefined) return '확인 불가'
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}초`
}

function escapeTable(value: string | undefined): string {
    return (value ?? '확인 불가').replaceAll('|', '\\|').replaceAll('\n', ' ')
}

export function formatChatRequestEvidenceMarkdown(evidence: ChatRequestEvidence): string {
    const lines = [
        '# RisuBard 채팅 요청 증거 보고서',
        '',
        `- 생성 시각: ${evidence.generatedAt}`,
        `- 채팅 ID: \`${evidence.chatId}\``,
        `- 요청 수: ${evidence.requestCount.toLocaleString('ko-KR')}`,
        `- 총 입력 토큰: ${evidence.totals.inputTokens.toLocaleString('ko-KR')}`,
        `- 총 출력 토큰: ${evidence.totals.outputTokens.toLocaleString('ko-KR')}`,
        ...(evidence.totals.legacyInputTokens === undefined ? [] : [
            `- 총 입력 토큰 (가상 레거시): ${evidence.totals.legacyInputTokens.toLocaleString('ko-KR')}`,
            `- 입력 토큰 절감량: ${number(evidence.totals.inputTokenSavings)}`,
            `- 입력 토큰 절감률: ${((evidence.totals.legacyInputSavingsRate ?? 0) * 100).toFixed(1)}%`,
        ]),
        '',
        '> 이 보고서는 요청 메타데이터만 포함합니다. 프롬프트, 응답 본문, 헤더와 인증 정보는 제외됩니다.',
    ]

    for (const [index, request] of evidence.requests.entries()) {
        lines.push(
            '',
            `## 요청 ${index + 1}`,
            '',
            '| 항목 | 값 |',
            '| --- | --- |',
            `| 시각 | ${request.timestamp} |`,
            `| 생성 ID | ${escapeTable(request.generationId)} |`,
            `| 종류 | ${request.source} |`,
            `| 모델 | ${escapeTable(request.model)} |`,
            `| 공급자 | ${escapeTable(request.provider)} |`,
            `| 결과 | ${request.outcome} |`,
            `| 경과 시간 | ${durationLabel(request.durationMs)} |`,
            `| 첫 토큰 | ${durationLabel(request.firstTokenMs)} |`,
            `| 입력 토큰 | ${number(request.inputTokens)} |`,
            `| 출력 토큰 | ${number(request.outputTokens)} |`,
            `| 추론 토큰 | ${number(request.reasoningTokens)} |`,
            `| 캐시 토큰 | ${number(request.cachedTokens)} |`,
        )
        if (request.injectionManifest) {
            lines.push(
                '',
                `### 입력 구성 · 총 ${number(request.injectionManifest.totalTokens)} 토큰`,
                '',
                '| 주입 항목 | 토큰 |',
                '| --- | ---: |',
                ...request.injectionManifest.items.map((item) => {
                    const label = item.name
                        ? `${injectionLabels[item.kind]} · ${escapeTable(item.name)}`
                        : injectionLabels[item.kind]
                    return `| ${label} | ${number(item.tokens)} |`
                }),
            )
        }
        if (request.legacyInput) {
            lines.push('', '### 레거시 입력 구성', '')
            if (request.legacyInput.mode === 'estimated') {
                lines.push(
                    '| 항목 | 값 |',
                    '| --- | ---: |',
                    `| 전체 활성 메시지 | ${number(request.legacyInput.activeMessageCount)} |`,
                    `| 현재 최근 메시지 | ${number(request.legacyInput.recentMessageCount)} |`,
                    `| 전체 채팅 토큰 | ${number(request.legacyInput.fullChatTokens)} |`,
                    `| 현재 최근 채팅 토큰 | ${number(request.legacyInput.recentChatTokens)} |`,
                    `| 제외한 BardWiki 토큰 | ${number(request.legacyInput.removedWikiTokens)} |`,
                    `| 가상 레거시 입력 토큰 | ${number(request.legacyInput.inputTokens)} |`,
                )
            }
            else if (request.legacyInput.mode === 'excluded') {
                lines.push('위키 없는 레거시 기준에서는 발생하지 않는 요청입니다.')
            }
            else if (request.legacyInput.mode === 'unchanged') {
                lines.push(`레거시 전환의 영향을 받지 않습니다. 입력 토큰: ${number(request.legacyInput.inputTokens)}`)
            }
            else {
                lines.push('연결된 생성 메시지 또는 입력 토큰이 없어 계산할 수 없습니다.')
            }
        }
    }
    return `${lines.join('\n')}\n`
}

/** Reads every retained, body-free request-log row belonging to one chat. */
export async function loadChatRequestEvidence(chatId: string): Promise<ChatRequestEvidence> {
    const entries: RequestLogEntry[] = []
    let beforeId: number | undefined
    while (true) {
        const page = await fetchRequestLogPage({
            sessionChatId: chatId,
            beforeId,
            limit: 500,
        })
        entries.push(...page.content)
        if (page.content.length < 500) break
        beforeId = page.content.at(-1)?.id
        if (beforeId === undefined) break
    }
    return buildChatRequestEvidence(chatId, entries)
}
