import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/SideChatList.svelte'
), 'utf8')
const dialogSource = readFileSync(resolve(
    process.cwd(), 'src/lib/SideBars/RisuBardSaveSlotsDialog.svelte'
), 'utf8')

describe('character sidebar save slot connections', () => {
    test('places new chat, save, and load actions in one normal-flow row', () => {
        expect(source).toContain('data-sidebar-chat-actions')
        expect(source).toContain('data-sidebar-new-chat')
        expect(source).toContain('data-risubard-save-chat')
        expect(source).toContain('data-risubard-load-chat')
        expect(source).toContain('grid-cols-3')
        expect(source).not.toContain('relative bottom-2 w-full')
        expect(source).not.toContain('relative bottom-1 grid')
        expect(source).toContain('<RisuBardSaveSlotsDialog')
    })

    test('finalizes a loaded wiki only after the new chat is persisted', () => {
        expect(source).toMatch(
            /prepareMemorySaveLoad[\s\S]*requestImmediateSave[\s\S]*action: 'finalize'/
        )
        expect(source).toMatch(
            /catch\(error\)[\s\S]*action: 'discard'/
        )
    })

    test('uses the defined theme tokens for opaque save slot surfaces', () => {
        expect(dialogSource).toContain('var(--color-darkbg)')
        expect(dialogSource).not.toMatch(
            /var\(--(?:darkbg|darkborderc|borderc|selected|textcolor|textcolor2)\)/
        )
    })
})
