import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chats = () => readFileSync('src/lib/ChatScreens/Chats.svelte', 'utf8')
const screen = () => readFileSync('src/lib/ChatScreens/DefaultChatScreen.svelte', 'utf8')
const chat = () => readFileSync('src/lib/ChatScreens/Chat.svelte', 'utf8')

describe('bounded chat-page UI connections', () => {
    it('caps mounted DOM rows independently from user chat-page pagination', () => {
        const source = chats()
        expect(source).toContain('pageStart')
        expect(source).toContain('pageEnd')
        expect(source).toContain('const domLimit: 60 | 40 = saverMode ? 40 : 60')
        expect(source).toContain('getChatWindow')
        expect(source).toContain('const loadStart = domWindow.end - 1')
        expect(source).toContain('const loadEnd = domWindow.start')
        expect(source).toContain('data-chat-spacer="after"')
        expect(source).toContain('data-chat-spacer="before"')
        expect(source).toContain('Map<string, MountedChat>')
        expect(source).toContain('messageId,')
        expect(source).not.toContain('messages.length - loadPages')
    })

    it('uses stable ID anchoring and cancels stale page fetch DOM restoration', () => {
        const source = screen()
        expect(source).toContain('chatWindowVersion')
        expect(source).toContain('requestVersion !== chatWindowVersion')
        expect(source).toContain('[data-chat-id]')
        expect(source).toContain('container.scrollTop += restored.getBoundingClientRect().top - anchor.top')
    })

    it('resolves a mounted row index by stable message ID before actions', () => {
        const source = chat()
        expect(source).toContain('messageId?: string')
        expect(source).toContain('message.findIndex((candidate) => candidate.chatId === messageId)')
        expect(source).toContain('idx: initialIdx = -1')
    })

    it('uses explicit bounded navigation instead of cumulative scroll loading', () => {
        const source = screen()
        expect(source).toContain('data-chat-pagination')
        expect(source).toContain('data-chat-page-previous')
        expect(source).toContain('data-chat-page-next')
        expect(source).toContain('data-chat-page-latest')
        expect(source).toContain('getChatPageBounds')
        expect(source).toContain('getChatPageForMessage')
        expect(source).not.toMatch(/loadPages\s*\+=/)
    })

    it('never expands the mounted chat to infinity for screenshots', () => {
        const source = screen()
        expect(source).not.toContain('loadPages = Infinity')
        expect(source).toContain('chat-page-${chatBounds.page + 1}')
    })
})
