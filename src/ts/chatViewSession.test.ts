import { describe, expect, it } from 'vitest'
import { loadChatViewSession, saveChatViewSession } from './chatViewSession'

describe('chat view session', () => {
    it('remembers the anchored message and scroll position independently for each chat', () => {
        saveChatViewSession('character-a/chat-a', { anchorId: 'm-12', scrollTop: -420 })
        saveChatViewSession('character-a/chat-b', { anchorId: null, scrollTop: -80 })

        expect(loadChatViewSession('character-a/chat-a')).toEqual({ anchorId: 'm-12', scrollTop: -420 })
        // `null` is a real answer: the view was pinned to the newest messages.
        expect(loadChatViewSession('character-a/chat-b')).toEqual({ anchorId: null, scrollTop: -80 })
    })

    it('keeps nothing for a chat whose scroll position was never a number', () => {
        saveChatViewSession('character-a/chat-c', { anchorId: 'm-3', scrollTop: Number.NaN })
        expect(loadChatViewSession('character-a/chat-c')).toBeNull()
    })
})
