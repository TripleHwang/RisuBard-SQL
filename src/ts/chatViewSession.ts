export interface ChatViewSession {
    page: number
    scrollTop: number
}

const chatViewSessions = new Map<string, ChatViewSession>()

export function loadChatViewSession(key: string): ChatViewSession | null {
    const session = chatViewSessions.get(key)
    return session ? { ...session } : null
}

export function saveChatViewSession(key: string, session: ChatViewSession): void {
    if (!key || !Number.isFinite(session.page) || !Number.isFinite(session.scrollTop)) return
    chatViewSessions.set(key, {
        page: Math.max(0, Math.floor(session.page)),
        scrollTop: session.scrollTop,
    })
}
