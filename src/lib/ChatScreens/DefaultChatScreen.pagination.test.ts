import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = (file: string) => readFileSync(file, 'utf8')

describe('continuous bounded chat history', () => {
    test('uses the full loaded range, serial reverse loading, and bottom-aligned Latest', () => {
        const screen = source('src/lib/ChatScreens/DefaultChatScreen.svelte')
        const chats = source('src/lib/ChatScreens/Chats.svelte')

        expect(screen).not.toContain('data-chat-pagination')
        expect(screen).not.toContain('data-chat-page-previous')
        expect(screen).not.toContain('getChatPageBounds')
        expect(screen).toContain('pageStart={0}')
        expect(screen).toContain('pageEnd={currentChat.length}')
        expect(screen).toContain('loadOlderUntilScrollable')
        expect(screen).toContain('loadOlderChatMessages')
        expect(screen).toContain('revealNewerMessages')
        expect(screen).toContain('historyLoadFailed')
        expect(chats).toContain('export const revealOlderMessages')
        expect(chats).toContain('export const revealNewerMessages')
        expect(chats).toContain('export const showLatestMessage')
        expect(chats).toContain("block: 'end'")
    })
})
