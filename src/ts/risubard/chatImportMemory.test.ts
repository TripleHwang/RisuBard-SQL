import { describe, expect, test } from 'vitest'
import type { Chat } from '../storage/database.svelte'
import { resetImportedBardWikiState } from './chatImportMemory'

describe('imported RisuBard chat memory state', () => {
    test('removes stale BardWiki markers when the source workspace is unavailable', () => {
        const chat = {
            message: [{
                role: 'char',
                data: 'reply',
                risubardMemoryConfirmed: true,
                risubardCanonicalReceipt: { changes: [] },
            }],
            risuBardLastAutosaveTurn: 12,
            risuBardWikiReboot: { status: 'paused' },
        } as unknown as Chat

        resetImportedBardWikiState(chat)

        expect(chat.message[0]).not.toHaveProperty('risubardMemoryConfirmed')
        expect(chat.message[0]).not.toHaveProperty('risubardCanonicalReceipt')
        expect(chat).not.toHaveProperty('risuBardLastAutosaveTurn')
        expect(chat).not.toHaveProperty('risuBardWikiReboot')
    })
})
