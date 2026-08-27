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

export type ChatWindowRequest = { key: string, version: number }

export type ReverseScrollMetrics = {
    scrollTop: number
    scrollHeight: number
    clientHeight: number
}

export const latestMessageScrollOptions = {
    block: 'end',
    behavior: 'instant',
} as const

export type ContinuousHistoryControllerOptions = {
    hasOlder: () => boolean
    isScrollable: () => boolean
    loadOlder: () => Promise<boolean>
    maxLoads?: number
}

/** Serializes reverse loads so a short initial window fills without races. */
export function createContinuousHistoryController(options: ContinuousHistoryControllerOptions) {
    let failed = false
    let inFlight: Promise<boolean> | null = null

    const loadOne = (): Promise<boolean> => {
        if (inFlight) return inFlight
        inFlight = (async () => {
            try {
                const loaded = await options.loadOlder()
                failed = !loaded
                return loaded
            } catch {
                failed = true
                return false
            } finally {
                inFlight = null
            }
        })()
        return inFlight
    }

    return {
        get failed() { return failed },
        get loading() { return inFlight !== null },
        async fillViewport(): Promise<boolean> {
            const maxLoads = Math.max(1, options.maxLoads ?? 100)
            let loads = 0
            while (!options.isScrollable() && options.hasOlder()) {
                if (loads >= maxLoads) {
                    failed = true
                    return false
                }
                if (!await loadOne()) return false
                loads += 1
            }
            return true
        },
        retry: loadOne,
        reset() { failed = false },
    }
}

/** Keeps virtual spacers inside the selected user-visible page. */
export function getChatPageWindow({ total, pageStart, pageEnd, anchorIndex, limit }: {
    total: number
    pageStart: number
    pageEnd: number
    anchorIndex: number
    limit: 60 | 40
}): ChatWindow {
    const safeTotal = Math.max(0, total)
    const start = Math.max(0, Math.min(safeTotal, pageStart))
    const end = Math.max(start, Math.min(safeTotal, pageEnd))
    const pageLength = end - start
    if (pageLength === 0) return { start, end, beforeCount: 0, afterCount: 0 }
    const anchor = Math.max(start, Math.min(end - 1, anchorIndex))
    const local = getChatWindow({ total: pageLength, anchorIndex: anchor - start, limit })
    return {
        start: start + local.start,
        end: start + local.end,
        beforeCount: local.beforeCount,
        afterCount: local.afterCount,
    }
}

/**
 * Distance from the visual top of a flex-column-reverse scroller.
 * Chromium/Firefox use a negative scrollTop while some WebKit paths expose
 * the mirrored positive value, so accept both representations.
 */
export function distanceFromReverseScrollTop(
    { scrollTop, scrollHeight, clientHeight }: ReverseScrollMetrics,
): number {
    const extent = Math.max(0, scrollHeight - clientHeight)
    return Math.min(Math.abs(extent + scrollTop), Math.abs(extent - scrollTop))
}

export function isNearReverseScrollTop(
    metrics: ReverseScrollMetrics,
    threshold = 120,
): boolean {
    const extent = Math.max(0, metrics.scrollHeight - metrics.clientHeight)
    return extent > 0 && distanceFromReverseScrollTop(metrics) <= Math.max(0, threshold)
}

export function isCurrentChatWindowRequest(request: ChatWindowRequest, current: ChatWindowRequest): boolean {
    return request.key === current.key && request.version === current.version
}

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
