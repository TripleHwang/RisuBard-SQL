import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const chats = () => readFileSync('src/lib/ChatScreens/Chats.svelte', 'utf8')
const screen = () => readFileSync('src/lib/ChatScreens/DefaultChatScreen.svelte', 'utf8')
const chat = () => readFileSync('src/lib/ChatScreens/Chat.svelte', 'utf8')

describe('bounded continuous chat UI connections', () => {
    it('caps mounted DOM rows across the whole locally loaded history', () => {
        const source = chats()
        expect(source).toContain('return saverMode ? 40 : 60')
        expect(source).toContain('getChatWindow')
        expect(source).toContain('revealOlderMessages')
        expect(source).toContain('revealNewerMessages')
        expect(source).toContain('showLatestMessage')
        expect(source).toContain('const loadStart = domWindow.end - 1')
        expect(source).toContain('const loadEnd = domWindow.start')
        expect(source).toContain('data-chat-spacer="after"')
        expect(source).toContain('data-chat-spacer="before"')
        expect(source).toContain('Map<string, MountedChat>')
        expect(source).toContain('messageId,')
        expect(source).toContain('messageHost.firstElementChild')
        expect(source).not.toContain('const lastEl = chatBody.firstElementChild')
        expect(source).not.toContain('messages.length - loadPages')
    })

    it('uses stable ID anchoring and cancels stale reverse fetch DOM restoration', () => {
        const source = screen()
        expect(source).toContain('chatWindowVersion')
        expect(source).toContain('isCurrentChatWindowRequest')
        expect(source).toContain('[data-chat-id]')
        expect(source).toContain('container.scrollTop += restored.getBoundingClientRect().top - anchor.top')
    })

    it('invalidates an older anchor request when the active chat changes', () => {
        const source = screen()
        expect(source).toContain('chatWindowVersion += 1')
    })

    it('resolves a mounted row index by stable message ID before actions', () => {
        const source = chat()
        expect(source).toContain('messageId?: string')
        expect(source).toContain('message.findIndex((candidate) => candidate.chatId === messageId)')
        expect(source).toContain('idx: initialIdx = -1')
        expect(source).toContain('$ReloadChatPointer[messageId]')
    })

    it('uses continuous scroll loading without visible pagination controls', () => {
        const source = screen()
        expect(source).not.toContain('data-chat-pagination')
        expect(source).not.toContain('getChatPageBounds')
        expect(source).toContain('isNearReverseScrollTop')
        expect(source).toContain('loadPreviousWindowOnScroll')
        expect(source).toContain('loadOlderUntilScrollable')
        expect(source).not.toMatch(/loadPages\s*\+=/)
    })

    it('never expands the mounted chat to infinity for screenshots', () => {
        const source = screen()
        expect(source).not.toContain('loadPages = Infinity')
        expect(source).toContain('chat-history-')
    })
})
