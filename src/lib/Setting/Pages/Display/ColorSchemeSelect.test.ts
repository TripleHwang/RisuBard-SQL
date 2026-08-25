import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { builtInColorSchemes } from 'src/ts/gui/colorschemePalettes'

const componentSource = readFileSync(
    resolve(process.cwd(), 'src/lib/Setting/Pages/Display/ColorSchemeSelect.svelte'),
    'utf8',
)

describe('color scheme visual selector', () => {
    test('renders the registered presets and keeps custom theme access', () => {
        expect(Object.keys(builtInColorSchemes)).toEqual(['dark', 'light', 'pastel-pop'])
        expect(componentSource).toContain('{#each colorSchemeList as scheme}')
        expect(componentSource).toContain('data-color-scheme-card={scheme}')
        expect(componentSource).toContain('data-color-scheme-card="custom"')
        expect(componentSource).not.toContain('<SelectInput')
    })

    test('makes selection and keyboard focus unambiguous and accessible', () => {
        expect(componentSource).toContain('type="button"')
        expect(componentSource).toContain('aria-pressed={isSelected(scheme)}')
        expect(componentSource).toContain('aria-label={optionLabel(scheme)}')
        expect(componentSource).toContain('class:border-primary={isSelected(scheme)}')
        expect(componentSource).toContain('class:ring-2={isSelected(scheme)}')
        expect(componentSource).toContain('focus-visible:ring-2')
        expect(componentSource).toContain('<CheckIcon')
    })

    test('previews real palette surfaces and the primary/accentText pairing', () => {
        for (const token of ['bgcolor', 'darkbg', 'borderc', 'selected', 'primary', 'accentText']) {
            expect(componentSource).toContain(`scheme.${token}`)
        }
        expect(componentSource).toContain('style:background-color={scheme.primary}')
        expect(componentSource).toContain('style:color={scheme.accentText}')
    })
})
