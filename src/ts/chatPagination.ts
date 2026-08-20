export const DEFAULT_CHAT_PAGE_SIZE = 30
export const MIN_CHAT_PAGE_SIZE = 10
export const MAX_CHAT_PAGE_SIZE = 200

export type ChatPageBounds = {
    page: number
    pageCount: number
    start: number
    end: number
}

function normalizeCount(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 0
    return Math.floor(value)
}

export function normalizeChatPageSize(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return DEFAULT_CHAT_PAGE_SIZE
    return Math.min(MAX_CHAT_PAGE_SIZE, Math.max(MIN_CHAT_PAGE_SIZE, Math.floor(parsed)))
}

export function getChatPageCount(messageCount: number, pageSize: number): number {
    const count = normalizeCount(messageCount)
    const size = normalizeChatPageSize(pageSize)
    return Math.max(1, Math.ceil(count / size))
}

export function getChatPageBounds(
    messageCount: number,
    pageSize: number,
    page: number,
): ChatPageBounds {
    const count = normalizeCount(messageCount)
    const size = normalizeChatPageSize(pageSize)
    const pageCount = getChatPageCount(count, size)
    const normalizedPage = Number.isFinite(page)
        ? Math.min(pageCount - 1, Math.max(0, Math.floor(page)))
        : pageCount - 1
    const start = Math.min(count, normalizedPage * size)
    return {
        page: normalizedPage,
        pageCount,
        start,
        end: Math.min(count, start + size),
    }
}

export function getLatestChatPage(messageCount: number, pageSize: number): number {
    return getChatPageCount(messageCount, pageSize) - 1
}

export function getChatPageForMessage(
    messageIndex: number,
    messageCount: number,
    pageSize: number,
): number {
    const count = normalizeCount(messageCount)
    if (count === 0) return 0
    const index = Number.isFinite(messageIndex)
        ? Math.min(count - 1, Math.max(0, Math.floor(messageIndex)))
        : count - 1
    return Math.floor(index / normalizeChatPageSize(pageSize))
}
