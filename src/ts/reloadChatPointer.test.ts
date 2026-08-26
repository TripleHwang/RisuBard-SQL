import { describe, expect, it } from 'vitest'
import { bumpMessageReloadPointer, messageReloadKey } from './reloadChatPointer'

describe('message reload pointers', () => {
    it('keeps a row reload tied to its message ID after an older prepend', () => {
        const pointers = bumpMessageReloadPointer({}, messageReloadKey({ chatId: 'm-new' }))
        const messages = [{ chatId: 'm-old' }, { chatId: 'm-new' }]

        expect(pointers[messages[1].chatId!]).toBe(1)
        expect(pointers['1']).toBeUndefined()
    })

    it('does not create a mutable-index fallback for messages without an ID', () => {
        expect(messageReloadKey({})).toBeNull()
        expect(bumpMessageReloadPointer({}, null)).toEqual({})
    })
})
