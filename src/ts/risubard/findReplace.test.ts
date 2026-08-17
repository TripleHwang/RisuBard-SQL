import { describe, expect, test, vi } from 'vitest'
import {
    applyChatFindReplace,
    previewFindReplace,
    replaceWikiText,
} from './findReplace'

describe('RisuBard find and replace', () => {
    const documents = [{
        id: 'character.gilbert',
        title: '길버드',
        content: '# 길버드\n\n길버드는 기사다.',
    }, {
        id: 'event.meeting',
        title: '첫 만남',
        content: '# 첫 만남\n\n길버드가 문을 열었다.',
    }]

    test('previews literal matches across wiki documents and chat history', () => {
        const messages = [{
            role: 'char' as const,
            data: '길버드가 웃었다.',
            saying: '길버드',
            swipes: ['길버드가 웃었다.', '길버드는 침묵했다.'],
            swipeId: 0,
        }]

        expect(previewFindReplace(documents, messages, '길버드')).toEqual({
            wikiMatches: 3,
            wikiDocuments: 2,
            chatMatches: 4,
            chatMessages: 1,
        })
    })

    test('replaces active chat text and every stored swipe literally', () => {
        const messages = [{
            role: 'char' as const,
            data: '길버드와 길버드',
            saying: '길버드',
            name: '길버드',
            swipes: ['길버드', '다른 답변의 길버드'],
            swipeId: 0,
        }]

        expect(applyChatFindReplace(messages, '길버드', '길버트')).toEqual({
            matches: 6,
            messages: 1,
        })
        expect(messages[0]).toMatchObject({
            data: '길버트와 길버트',
            saying: '길버트',
            name: '길버트',
            swipes: ['길버트', '다른 답변의 길버트'],
        })
    })

    test('posts a bounded wiki-wide replacement request', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
            matches: 3,
            documents: 2,
        }), { status: 200 }))

        await expect(replaceWikiText({
            characterId: 'character', chatId: 'chat',
            find: '길버드', replacement: '길버트',
            fetchImpl: fetchImpl as typeof fetch,
            createAuth: async () => 'auth-token',
        })).resolves.toEqual({ matches: 3, documents: 2 })
        expect(fetchImpl).toHaveBeenCalledWith(
            '/api/risubard/memory/wiki/replace',
            expect.objectContaining({
                method: 'POST',
                body: JSON.stringify({
                    characterId: 'character', chatId: 'chat',
                    find: '길버드', replacement: '길버트',
                }),
            })
        )
    })
})
