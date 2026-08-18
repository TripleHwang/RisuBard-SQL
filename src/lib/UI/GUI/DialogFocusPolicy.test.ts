import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { handleDialogCloseAutoFocus } from './dialogFocusPolicy'

function source(path: string): string {
    const absolute = resolve(process.cwd(), path)
    return existsSync(absolute) ? readFileSync(absolute, 'utf8') : ''
}

describe('shared dialog close-focus policy', () => {
    test('suppresses automatic focus restoration after pointer interaction', () => {
        window.dispatchEvent(new Event('pointerdown'))
        const closeEvent = new Event('close-auto-focus', { cancelable: true })

        handleDialogCloseAutoFocus(closeEvent)

        expect(closeEvent.defaultPrevented).toBe(true)
    })

    test('preserves automatic focus restoration after keyboard interaction', () => {
        window.dispatchEvent(new Event('pointerdown'))
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
        const closeEvent = new Event('close-auto-focus', { cancelable: true })

        handleDialogCloseAutoFocus(closeEvent)

        expect(closeEvent.defaultPrevented).toBe(false)
    })

    test('applies the policy to dialogs and alert dialogs', () => {
        for (const component of [
            'ShDialog.svelte',
            'ShAlertDialog.svelte',
            'ShLoadingDialog.svelte',
        ]) {
            const componentSource = source(`src/lib/UI/GUI/${component}`)
            expect(componentSource).toContain('handleDialogCloseAutoFocus')
            expect(componentSource).toContain('onCloseAutoFocus={handleDialogCloseAutoFocus}')
        }
    })
})
