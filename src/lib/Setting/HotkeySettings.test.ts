import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const hotkeyPath = resolve(process.cwd(), 'src/lib/Setting/Pages/HotkeySettings.svelte')

describe('hotkey settings layout', () => {
    test('uses a legible action, modifier, and key grid', () => {
        const source = readFileSync(hotkeyPath, 'utf8')

        expect(source).toContain('data-hotkey-table')
        expect(source).toContain('role="columnheader"')
        expect(source).toContain('data-hotkey-row')
        expect(source).toContain('data-hotkey-modifiers')
        expect(source).toContain('data-hotkey-key')
        expect(source).toContain('grid-template-columns')
        expect(source).not.toContain('window.innerWidth')
    })

    test('exposes modifier state and key capture accessibly', () => {
        const source = readFileSync(hotkeyPath, 'utf8')

        expect(source).toContain('aria-pressed={!!hotkey.ctrl}')
        expect(source).toContain('aria-pressed={!!hotkey.shift}')
        expect(source).toContain('aria-pressed={!!hotkey.alt}')
        expect(source).toContain('onkeydown={(event) => captureKey(event, hotkey)}')
    })
})
