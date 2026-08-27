import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const screen = () => readFileSync('src/lib/ChatScreens/DefaultChatScreen.svelte', 'utf8')

describe('chat-page navigation destinations', () => {
    test('moves Next to the next page top while Latest remains bottom-directed', () => {
        const source = screen()
        const pagination = source.slice(source.indexOf('data-chat-pagination'), source.indexOf('</nav>', source.indexOf('data-chat-pagination')))

        expect(pagination).toContain('data-chat-page-next')
        expect(pagination).toContain('onclick={() => void selectChatPage(chatBounds.page + 1)}')
        expect(pagination).toContain('data-chat-page-latest')
        expect(pagination).toContain('onclick={() => void selectChatPage(chatBounds.pageCount - 1, true)}')

        const selectPage = source.slice(source.indexOf('async function selectChatPage'), source.indexOf('async function selectPreviousChatPage'))
        expect(selectPage).toContain('else scrollToLoadedTop()')
        expect(selectPage).toContain('if (scrollToLatest) chatsInstance?.scrollToLatestMessage()')
    })
})
