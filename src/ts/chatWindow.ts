export type ChatWindow = {
    start: number
    end: number
    beforeCount: number
    afterCount: number
}

export function getChatWindow({ total, anchorIndex, limit }: {
    total: number
    anchorIndex: number
    limit: 60 | 40
}): ChatWindow {
    const safeTotal = Math.max(0, total)
    const start = Math.max(0, Math.min(safeTotal - limit, anchorIndex - Math.floor(limit / 2)))
    const end = Math.min(safeTotal, start + limit)
    return { start, end, beforeCount: start, afterCount: safeTotal - end }
}

export function estimateSpacerHeight(measured: number[], count: number, fallback = 24): number {
    const average = measured.length > 0
        ? measured.reduce((sum, height) => sum + height, 0) / measured.length
        : fallback
    return average * Math.max(0, count)
}

/**
 * The index the DOM window should centre on one step older (`-1`) or newer
 * (`+1`) than `current`.
 *
 * Half a window per step: the newly mounted rows land entirely outside the
 * viewport, so the step is invisible, and the sentinel that triggered it moves
 * out of range instead of firing again. Clamping to the last index rather than
 * to `end` is what makes a step at either extreme return the window it was
 * given, which is how the caller knows there is nowhere left to slide and it is
 * time to ask storage instead.
 */
export function stepChatWindowCenter(current: ChatWindow, total: number, limit: 60 | 40, direction: -1 | 1): number {
    const step = Math.max(1, Math.floor(limit / 2))
    const centre = Math.floor((current.start + current.end - 1) / 2)
    return Math.max(0, Math.min(Math.max(0, total - 1), centre + direction * step))
}

export type ChatWindowRequest = { key: string, version: number }

export function isCurrentChatWindowRequest(request: ChatWindowRequest, current: ChatWindowRequest): boolean {
    return request.key === current.key && request.version === current.version
}

export type ReverseMessagePage<T extends { chatId?: string }> = {
    offset: number
    total: number
    messages: T[]
}

export type ReverseWindow = { offset: number, total: number, ids: string[] }

/** Validates a page fetched immediately before a currently loaded reverse window. */
export function validateOlderMessagePage<T extends { chatId?: string }>(page: ReverseMessagePage<T>, current: ReverseWindow): T[] {
    const ids = page.messages.map(message => message.chatId ?? '')
    // `current.total` is a count snapshotted when the window was built, so any
    // message deleted since then legitimately moves it. Comparing the two made a
    // single deletion strand the rest of the history behind a throw for the whole
    // session. Contiguity and identity below are the checks that catch real
    // corruption; the caller adopts the page's fresh total.
    if (!Number.isInteger(page.offset) || page.offset < 0) throw new Error('Reverse page metadata changed')
    if (page.offset + page.messages.length !== current.offset) throw new Error('Reverse page is not contiguous')
    if (ids.some(id => !id) || new Set(ids).size !== ids.length || ids.some(id => current.ids.includes(id))) throw new Error('Reverse page has duplicate message IDs')
    return page.messages
}

/** flex-col-reverse lays the first DOM child at the visual bottom. */
export const reverseSpacerOrder = ['after', 'messages', 'before'] as const
