import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = () => readFileSync(resolve('src/lib/ChatScreens/ArcaChatLogDialog.svelte'), 'utf8')
const chatScreen = () => readFileSync(resolve('src/lib/ChatScreens/DefaultChatScreen.svelte'), 'utf8')

describe('ArcaChatLogDialog shell', () => {
    test('uses the canonical dialog with simple whole-chat and range controls', () => {
        const component = source()

        expect(component).toContain("import ShDialog from '../UI/GUI/ShDialog.svelte'")
        expect(component).toContain('<ShDialog')
        expect(component).toContain('data-arca-log-mode="all"')
        expect(component).toContain('data-arca-log-mode="range"')
        expect(component).toContain('data-arca-log-preview')
    })

    test('stages the real chat renderer and copies rich and plain clipboard formats', () => {
        const component = source()

        expect(component).toContain('mount(Chat')
        expect(component).toContain('const requestedKey = selectionKey')
        expect(component).toContain('preparedKey = requestedKey')
        expect(component).toContain('new ClipboardItem')
        expect(component).toContain("'text/html'")
        expect(component).toContain("'text/plain'")
    })

    test('keeps a responsive single-column mobile layout', () => {
        const component = source()

        expect(component).toMatch(/@media\s*\(max-width:\s*640px\)/)
        expect(component).toContain('grid-template-columns: minmax(0, 1fr)')
    })

    test('is opened from the existing chat menu with the full current chat', () => {
        const screen = chatScreen()

        expect(screen).toContain("import ArcaChatLogDialog from './ArcaChatLogDialog.svelte'")
        expect(screen).toContain('data-open-arca-chat-log')
        expect(screen).toContain('<ArcaChatLogDialog')
        expect(screen).toContain('chat={currentChatSlot}')
    })
})
