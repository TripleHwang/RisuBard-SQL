import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(
    resolve(process.cwd(), 'src/lib/Others/AlertComp.svelte'),
    'utf8',
)

describe('shared alert input submission', () => {
    test('routes Enter and the confirm button through one form submit path', () => {
        const inputDialog = source.slice(
            source.indexOf("open={$alertStore.type === 'input'}"),
            source.indexOf('<ShLoadingDialog'),
        )

        expect(inputDialog).toMatch(/<form\s+id="alert-input-form"/)
        expect(inputDialog).toContain('onsubmit={(event) => {')
        expect(inputDialog).toContain('event.preventDefault()')
        expect(inputDialog).toContain('event.stopPropagation()')
        expect(inputDialog).toContain("alertStore.set({ type: 'none', msg: input })")
        expect(inputDialog).toContain('type="submit"')
        expect(inputDialog).toContain('form="alert-input-form"')
        expect(inputDialog).not.toContain("e.key === 'Enter'")
    })

    test('keeps folder and toggle-preset naming on the shared input dialog', () => {
        const vault = readFileSync(
            resolve(process.cwd(), 'src/lib/SideBars/CharacterVaultDialog.svelte'),
            'utf8',
        )
        const presets = readFileSync(
            resolve(process.cwd(), 'src/lib/SideBars/TogglePresetManager.svelte'),
            'utf8',
        )

        expect(vault).toContain("alertInput('새 폴더 이름'")
        expect(presets).toContain('await alertInput(')
    })
})
