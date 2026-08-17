import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const receipt = readFileSync(resolve(
    process.cwd(),
    'src/lib/ChatScreens/RisuBardTurnReceipt.svelte'
), 'utf8')
const chat = readFileSync(resolve(
    process.cwd(),
    'src/lib/ChatScreens/Chat.svelte'
), 'utf8')
const chats = readFileSync(resolve(
    process.cwd(),
    'src/lib/ChatScreens/Chats.svelte'
), 'utf8')
const processSource = readFileSync(resolve(
    process.cwd(),
    'src/ts/process/index.svelte.ts'
), 'utf8')

describe('per-assistant canonical turn receipt', () => {
    test('renders whole-turn and per-document undo from persisted messages', () => {
        expect(receipt).toContain('data-risubard-turn-receipt')
        expect(receipt).toContain('risuBardUndoTurnCanon')
        expect(receipt).toContain('undo(change.documentId)')
        expect(chat).toContain('role === \'char\' && canonicalReceipt')
        expect(chats).toContain(
            'canonicalReceipt: message.risubardCanonicalReceipt'
        )
        expect(chats).toContain('JSON.stringify(message.risubardCanonicalReceipt')
        expect(receipt).toContain('change.undoConflict')
        expect(receipt).toContain('risuBardCanonUndoConflictChanged')
        expect(processSource).toContain('if (!documentId && updated.undoneAt)')
        expect(processSource).toContain('message.risubardMemoryConfirmed = false')
    })
})
