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

export type MessageAnchor = { id: string, top: number }

export function restoreMessageAnchor(scroller: HTMLElement, anchor: MessageAnchor | null, element: HTMLElement | null): boolean {
    if (!anchor || !element) return false
    scroller.scrollTop += element.getBoundingClientRect().top - anchor.top
    return true
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
    if (!Number.isInteger(page.offset) || page.offset < 0 || page.total !== current.total) throw new Error('Reverse page metadata changed')
    if (page.offset + page.messages.length !== current.offset) throw new Error('Reverse page is not contiguous')
    if (ids.some(id => !id) || new Set(ids).size !== ids.length || ids.some(id => current.ids.includes(id))) throw new Error('Reverse page has duplicate message IDs')
    return page.messages
}

/** flex-col-reverse lays the first DOM child at the visual bottom. */
export const reverseSpacerOrder = ['after', 'messages', 'before'] as const
