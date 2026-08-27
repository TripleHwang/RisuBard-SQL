import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('message edit completion shortcut', () => {
    test('saves a message edit on Ctrl/Cmd+Enter in every message editor', () => {
        const chat = source('src/lib/ChatScreens/Chat.svelte')
        const autoresize = source('src/lib/UI/GUI/TextAreaResizable.svelte')

        expect(chat).toContain('function finishMessageEdit(event: KeyboardEvent)')
        expect(chat).toContain("event.key === 'Enter' && (event.ctrlKey || event.metaKey)")
        expect(chat).toContain('event.preventDefault()')
        expect(chat).toContain('editMode = false')
        expect(chat).toContain('edit()')
        expect(chat.match(/onkeydown=\{finishMessageEdit\}/g)).toHaveLength(2)
        expect(autoresize).toContain('onkeydown?: (event: KeyboardEvent) => void')
        expect(autoresize).toContain('onkeydown={onkeydown}')
    })
})
