import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('modal surface contract', () => {
    test('defines one theme-safe modal visual language', () => {
        const styles = source('src/styles.css')

        expect(styles).toContain('.risu-modal-overlay')
        expect(styles).toContain('var(--color-overlay) 58%')
        expect(styles).toContain('.risu-modal-surface')
        expect(styles).toContain('background: var(--color-darkbg)')
        expect(styles).toContain('border: 1px solid var(--color-darkborderc)')
        expect(styles).toContain('border-radius: 1rem')
        expect(styles).toContain('.risu-modal-header')
        expect(styles).toContain('.risu-modal-close')
    })

    test('shared dialog primitives use the canonical overlay and surface', () => {
        for (const file of [
            'src/lib/UI/GUI/ShDialog.svelte',
            'src/lib/UI/GUI/ShAlertDialog.svelte',
            'src/lib/UI/GUI/ShLoadingDialog.svelte',
        ]) {
            const component = source(file)
            expect(component, file).toContain('risu-modal-overlay')
            expect(component, file).toContain('risu-modal-surface')
        }

        const dialog = source('src/lib/UI/GUI/ShDialog.svelte')
        expect(dialog).toContain('risu-modal-header')
        expect(dialog).toContain('risu-modal-close')
    })
})
