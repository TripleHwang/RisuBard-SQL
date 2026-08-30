export const DEFAULT_CHAT_PAGE_SIZE = 30
export const MIN_CHAT_PAGE_SIZE = 10
export const MAX_CHAT_PAGE_SIZE = 200

/**
 * How many messages one page of chat history carries.
 *
 * This was the size of a *displayed* page while the chat screen sliced its
 * history into numbered pages. The screen now follows the scroll instead, so
 * the number governs the only paging that is left: how much older history one
 * scroll to the top of the conversation fetches from storage.
 */
export function normalizeChatPageSize(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(parsed)) return DEFAULT_CHAT_PAGE_SIZE
    return Math.min(MAX_CHAT_PAGE_SIZE, Math.max(MIN_CHAT_PAGE_SIZE, Math.floor(parsed)))
}
