import { describe, expect, it } from 'vitest'
import { loadChatViewSession, saveChatViewSession } from './chatViewSession'

describe('chat view session', () => {
    it('remembers page and scroll position independently for each chat', () => {
        saveChatViewSession('character-a/chat-a', { page: 1, scrollTop: -420 })
        saveChatViewSession('character-a/chat-b', { page: 3, scrollTop: -80 })

        expect(loadChatViewSession('character-a/chat-a')).toEqual({ page: 1, scrollTop: -420 })
        expect(loadChatViewSession('character-a/chat-b')).toEqual({ page: 3, scrollTop: -80 })
    })
})
