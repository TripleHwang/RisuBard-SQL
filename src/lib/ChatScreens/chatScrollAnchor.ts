const MIN_CORRECTION_PX = 1.25

export interface ChatScrollAnchor {
    contextKey: string
    messageIndex: number
    messageCount: number
    offsetTop: number
    atLatest: boolean
}

export type ChatScrollRestoreResult =
    | 'restored'
    | 'stable'
    | 'context-changed'
    | 'missing'
    | 'new-message'

function getIndexedMessages(container: HTMLElement) {
    return Array.from(container.querySelectorAll<HTMLElement>('[data-chat-index]'))
        .map((element) => ({
            element,
            index: Number(element.dataset.chatIndex),
            rect: element.getBoundingClientRect(),
        }))
        .filter((message) => Number.isInteger(message.index) && message.index >= 0)
}

export function captureChatScrollAnchor(
    container: HTMLElement,
    contextKey: string,
    messageCount: number,
): ChatScrollAnchor | null {
    if (!contextKey || messageCount <= 0) return null

    const containerRect = container.getBoundingClientRect()
    const viewportTop = containerRect.top + 1
    const viewportBottom = containerRect.bottom - 1
    const messages = getIndexedMessages(container)
    let selected: (typeof messages)[number] | null = null
    let bestScore = Number.POSITIVE_INFINITY

    for (const message of messages) {
        if (message.rect.bottom <= viewportTop || message.rect.top >= viewportBottom) continue
        const crossesTop = message.rect.top <= viewportTop && message.rect.bottom > viewportTop
        const score = crossesTop
            ? Math.abs(message.rect.top - viewportTop) * 0.001
            : Math.abs(message.rect.top - viewportTop) + 10
        if (score < bestScore) {
            selected = message
            bestScore = score
        }
    }

    if (!selected) return null
    const newest = messages.reduce<(typeof messages)[number] | null>(
        (current, message) => !current || message.index > current.index ? message : current,
        null,
    )

    return {
        contextKey,
        messageIndex: selected.index,
        messageCount,
        offsetTop: selected.rect.top - containerRect.top,
        atLatest: Boolean(newest && newest.rect.top <= containerRect.bottom + 100),
    }
}

export function restoreChatScrollAnchor(
    container: HTMLElement,
    anchor: ChatScrollAnchor,
    contextKey: string,
    messageCount: number,
): ChatScrollRestoreResult {
    if (anchor.contextKey !== contextKey) return 'context-changed'
    if (anchor.messageIndex >= messageCount) return 'missing'
    if (anchor.atLatest && messageCount > anchor.messageCount) return 'new-message'

    const target = container.querySelector<HTMLElement>(
        `[data-chat-index="${anchor.messageIndex}"]`,
    )
    if (!target) return 'missing'

    const currentOffset = target.getBoundingClientRect().top
        - container.getBoundingClientRect().top
    const delta = currentOffset - anchor.offsetTop
    if (Math.abs(delta) < MIN_CORRECTION_PX) return 'stable'

    container.scrollTo({
        top: container.scrollTop + delta,
        behavior: 'instant',
    })
    return 'restored'
}
