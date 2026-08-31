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

/**
 * How many pages of `pageSize` a message count divides into, at least one.
 *
 * The chat screen's numbered pages are gone, and the rest of that family --
 * `getChatPageBounds`, `getChatPageForMessage`, `getLatestChatPage` -- went
 * with them. This one is back because the Arca chat-log export dialog reaches
 * for it, and there "page" is not a view at all: it is the chunk the user
 * picks a range of when exporting. `arcaChatLog.ts` already does this same
 * `ceil` inline for the selection itself, so the dialog's bound and the
 * selection agree by construction rather than by coincidence.
 */
export function getChatPageCount(messageCount: number, pageSize: number): number {
    const count = Number.isFinite(messageCount) ? Math.max(0, Math.floor(messageCount)) : 0
    return Math.max(1, Math.ceil(count / normalizeChatPageSize(pageSize)))
}
