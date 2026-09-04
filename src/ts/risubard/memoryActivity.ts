export const RISUBARD_MEMORY_ACTIVITY_EVENT = 'risubard-memory-activity'

export interface RisuBardContextTrace {
    mode: 'disabled' | 'legacy' | 'current'
    recentMessages: Array<{ id: string; role: 'user' | 'char' }>
    wikiPaths: string[]
    selectedTokens: number
    inquiryDurationMs: number
}

export interface RisuBardLiveActivity {
    characterId: string
    chatId: string
    operation: 'context' | 'request' | 'wiki-save' | 'wiki-trash' | 'wiki-retract' | 'error'
    timestamp: number
    message: string
    wikiPaths?: string[]
}

const recentRisuBardMemoryActivity: RisuBardLiveActivity[] = []

export function getRecentRisuBardMemoryActivity(
    characterId: string,
    chatId: string
): RisuBardLiveActivity[] {
    return recentRisuBardMemoryActivity.filter((item) =>
        item.characterId === characterId && item.chatId === chatId
    ).slice(0, 50).map((item) => ({
        ...item,
        ...(item.wikiPaths ? { wikiPaths: [...item.wikiPaths] } : {}),
    }))
}

export function sourceIdToWikiPath(sourceId: string): string | null {
    const prefix = 'narrative-memory:wiki:'
    if (!sourceId.startsWith(prefix)) return null
    const path = sourceId.slice(prefix.length).replace(/\\/g, '/')
    if (!path.endsWith('.md')
        || path.startsWith('/')
        || path.split('/').some((part) => part === '..' || part === '')) {
        return null
    }
    return path
}

export function createRisuBardContextTrace(input: {
    mode: RisuBardContextTrace['mode']
    recentMessages: Array<{ id: string; role: 'user' | 'char' }>
    selectedSourceIds: string[]
    selectedTokens: number
    inquiryDurationMs: number
}): RisuBardContextTrace {
    return {
        mode: input.mode,
        recentMessages: input.recentMessages.slice(-100).map((message) => ({
            id: String(message.id).slice(0, 1_024),
            role: message.role,
        })),
        wikiPaths: [...new Set(input.selectedSourceIds
            .map(sourceIdToWikiPath)
            .filter((path): path is string => path !== null))].slice(0, 16),
        selectedTokens: Math.max(0, Math.round(input.selectedTokens)),
        inquiryDurationMs: Math.max(0, Math.round(input.inquiryDurationMs)),
    }
}

export function traceRecentMessagesFromPrompt(
    messages: ReadonlyArray<{
        role: 'system' | 'user' | 'assistant' | 'function'
        memo?: string
        content?: unknown
    }>
): RisuBardContextTrace['recentMessages'] {
    return messages.flatMap((message) =>
        typeof message.memo === 'string' && message.memo.length > 0
            && (message.role === 'user' || message.role === 'assistant')
            ? [{
                id: message.memo,
                role: message.role === 'user' ? 'user' : 'char',
            } as const]
            : []
    )
}

/**
 * One live-activity line for a transient-failure wait: what went wrong, how
 * long the pause is, and which attempt this is. Without it a 30-second backoff
 * is indistinguishable from a hung reboot.
 */
export function formatRisuBardRetryNotice(notice: {
    attempt: number
    maxAttempts: number
    delayMs: number
    status?: number
    fromRetryAfter?: boolean
}): string {
    const seconds = Math.max(1, Math.round(notice.delayMs / 1_000))
    const cause = notice.status === 429
        ? '요청 한도에 걸렸습니다'
        : notice.status === 408
            ? '요청이 시간 초과되었습니다'
            : '모델 제공자가 일시적으로 응답하지 못했습니다'
    const source = notice.fromRetryAfter ? ' · 제공자 지정 대기' : ''
    return `${cause}(HTTP ${notice.status ?? '?'}). ${seconds}초 후 재시도합니다`
        + ` (${notice.attempt}/${notice.maxAttempts}${source}).`
}

export function publishRisuBardMemoryActivity(
    detail: RisuBardLiveActivity
): void {
    recentRisuBardMemoryActivity.unshift({
        ...detail,
        message: detail.message.slice(0, 1_024),
        ...(detail.wikiPaths ? {
            wikiPaths: detail.wikiPaths.slice(0, 16),
        } : {}),
    })
    recentRisuBardMemoryActivity.splice(200)
    if (typeof window === 'undefined') return
    window.dispatchEvent(new CustomEvent(RISUBARD_MEMORY_ACTIVITY_EVENT, {
        detail,
    }))
}
