export interface ChatViewSession {
    /**
     * The message the mounted window was centred on, by stable id, or `null`
     * when the view was pinned to the newest messages.
     *
     * An index would be restored against a different array: storage prepends
     * older pages and releases the newest end while a chat sits in the
     * background, and both move every index. An id either finds its message or
     * is honestly absent.
     */
    anchorId: string | null
    scrollTop: number
}

const chatViewSessions = new Map<string, ChatViewSession>()

export function loadChatViewSession(key: string): ChatViewSession | null {
    const session = chatViewSessions.get(key)
    return session ? { ...session } : null
}

export function saveChatViewSession(key: string, session: ChatViewSession): void {
    if (!key || !Number.isFinite(session.scrollTop)) return
    chatViewSessions.set(key, {
        anchorId: session.anchorId || null,
        scrollTop: session.scrollTop,
    })
}
