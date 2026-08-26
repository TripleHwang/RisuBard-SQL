import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { DBState } from 'src/ts/stores.svelte'
import { updateColorScheme, updateTextThemeAndCSS } from 'src/ts/gui/colorscheme'
import { lightColorScheme, pastelPopColorScheme } from 'src/ts/gui/colorschemePalettes'
import { uiThemeTokens } from 'src/ts/gui/uiThemeTokens'
import CustomColorSchemeEditor from './CustomColorSchemeEditor.svelte'
import CustomTextThemeEditor from './CustomTextThemeEditor.svelte'
import { resolveTextTheme, textThemeFields } from 'src/ts/gui/textTheme'

vi.mock('src/ts/stores.svelte', async () => {
    const { writable } = await import('svelte/store')
    return { DBState: { db: {} }, isTouchDevice: writable(false) }
})
vi.mock('src/ts/gui/colorscheme', () => ({
    updateColorScheme: vi.fn(), changeColorSchemeType: vi.fn(),
    updateTextThemeAndCSS: vi.fn(),
    changeColorScheme: vi.fn(), exportColorScheme: vi.fn(), importColorScheme: vi.fn(),
}))
vi.mock('src/lang', () => ({ language: {} }))

let mounted: ReturnType<typeof mount> | undefined
beforeEach(() => {
    vi.clearAllMocks()
    DBState.db = {
        colorSchemeName: 'light', colorScheme: { ...lightColorScheme }, language: 'ko',
        textTheme: 'standard', customTextTheme: resolveTextTheme('standard', 'dark'),
    } as typeof DBState.db
})

describe('dialogue color settings', () => {
    test('preserves CSS-valued dialogue colors in an exact editable text field', async () => {
        DBState.db.textTheme = 'custom'
        DBState.db.customTextTheme.FontColorQuote2 = 'var(--color-info)'
        mounted = mount(CustomTextThemeEditor, { target: document.body })
        await tick()
        expect(document.querySelector<HTMLInputElement>('#theme-text-FontColorQuote2')?.value).toBe('var(--color-info)')
        expect(document.querySelector('[data-text-color="FontColorQuote2"]')).toBeNull()
        expect(DBState.db.customTextTheme.FontColorQuote2).toBe('var(--color-info)')
    })
    test('shows the six text roles and auto-contrast on standard themes without changing settings', async () => {
        mounted = mount(CustomTextThemeEditor, { target: document.body })
        await tick()
        for (const field of textThemeFields) {
            expect(document.querySelector(`[data-text-color="${field.key}"]`), field.key).not.toBeNull()
        }
        expect(document.querySelector<HTMLInputElement>('[data-text-auto-contrast]')?.checked).toBe(true)
        expect(DBState.db.textTheme).toBe('standard')
        expect(updateTextThemeAndCSS).not.toHaveBeenCalled()
    })

    test('editing dialogue copies the active light text palette rather than stale dark custom defaults', async () => {
        mounted = mount(CustomTextThemeEditor, { target: document.body })
        await tick()
        const input = document.querySelector<HTMLInputElement>('[data-text-color="FontColorQuote2"]')
        expect(input).not.toBeNull()
        input!.value = '#7c2d12'
        input!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(DBState.db.textTheme).toBe('custom')
        expect(DBState.db.customTextTheme.FontColorQuote2).toBe('#7c2d12')
        expect(DBState.db.customTextTheme.FontColorStandard).toBe('#0f172a')
        expect(updateTextThemeAndCSS).toHaveBeenCalledOnce()
    })

    test('lets the user disable automatic correction and return to theme-aware defaults', async () => {
        DBState.db.textTheme = 'custom'
        mounted = mount(CustomTextThemeEditor, { target: document.body })
        await tick()
        const toggle = document.querySelector<HTMLInputElement>('[data-text-auto-contrast]')
        expect(toggle).not.toBeNull()
        toggle!.checked = false
        toggle!.dispatchEvent(new Event('change', { bubbles: true }))
        expect(DBState.db.textThemeAutoContrast).toBe(false)
        const reset = document.querySelector<HTMLButtonElement>('[data-reset-text-colors]')
        expect(reset).not.toBeNull()
        reset!.click()
        expect(DBState.db.textTheme).toBe('standard')
        expect(DBState.db.textThemeAutoContrast).toBe(true)
    })
})
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('editable semantic color settings', () => {
    test('keeps the Pastel surface foreground contract when copying it to Custom', async () => {
        DBState.db.colorSchemeName = 'pastel-pop'
        DBState.db.colorScheme = { ...pastelPopColorScheme }
        mounted = mount(CustomColorSchemeEditor, { target: document.body })
        await tick()
        const input = document.querySelector<HTMLInputElement>('[data-ui-color="binding"]')!
        input.value = '#fce7f3'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        expect(DBState.db.colorScheme.baseScheme).toBe('pastel-pop')
        expect(DBState.db.colorScheme.accentText).toBe(pastelPopColorScheme.accentText)
    })

    test.each(['#abc8', '#aabbcc80'])('shows and preserves the alpha of imported %s while editing its swatch', async (color) => {
        DBState.db.colorSchemeName = 'custom'
        DBState.db.colorScheme.uiColors = { binding: color }
        mounted = mount(CustomColorSchemeEditor, { target: document.body })
        await tick()
        const input = document.querySelector<HTMLInputElement>('[data-ui-color="binding"]')!
        expect(input.value).toBe('#aabbcc')
        const raw = document.querySelector<HTMLInputElement>('#theme-role-binding')!
        expect(raw.type).toBe('text')
        expect(raw.value).toBe(color)
        input.value = '#123456'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        expect(DBState.db.colorScheme.uiColors?.binding).toBe(color === '#abc8' ? '#12345688' : '#12345680')
    })

    test('lets the user edit an exact alpha hex value', async () => {
        mounted = mount(CustomColorSchemeEditor, { target: document.body })
        await tick()
        const raw = document.querySelector<HTMLInputElement>('#theme-role-binding')!
        raw.value = '#aabbcc80'
        raw.dispatchEvent(new Event('change', { bubbles: true }))
        expect(DBState.db.colorScheme.uiColors?.binding).toBe('#aabbcc80')
    })

    test('applies valid typed colors immediately but leaves incomplete input editable', async () => {
        mounted = mount(CustomColorSchemeEditor, { target: document.body })
        await tick()
        const raw = document.querySelector<HTMLInputElement>('#theme-role-binding')!
        raw.value = '#a'
        raw.dispatchEvent(new Event('input', { bubbles: true }))
        expect(raw.value).toBe('#a')
        expect(DBState.db.colorSchemeName).toBe('light')
        raw.value = '#aabbcc'
        raw.dispatchEvent(new Event('input', { bubbles: true }))
        expect(DBState.db.colorScheme.uiColors?.binding).toBe('#aabbcc')
    })

    test('shows every role on built-in skins without changing the selection on mount', async () => {
        mounted = mount(CustomColorSchemeEditor, { target: document.body })
        await tick()
        for (const field of uiThemeTokens) {
            expect(document.querySelector(`[data-ui-color="${field.token}"]`), field.token).not.toBeNull()
        }
        expect(DBState.db.colorSchemeName).toBe('light')
        expect(updateColorScheme).not.toHaveBeenCalled()
    })

    test('editing a binding color clones the current skin to Custom without losing its base colors', async () => {
        mounted = mount(CustomColorSchemeEditor, { target: document.body })
        await tick()
        const input = document.querySelector<HTMLInputElement>('[data-ui-color="binding"]')
        expect(input).not.toBeNull()
        input!.value = '#fce7f3'
        input!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()

        expect(DBState.db.colorSchemeName).toBe('custom')
        expect(DBState.db.colorScheme.bgcolor).toBe(lightColorScheme.bgcolor)
        expect(DBState.db.colorScheme.uiColors?.binding).toBe('#fce7f3')
        expect(updateColorScheme).toHaveBeenCalledOnce()
    })

    test('resetting one role removes only that override', async () => {
        DBState.db.colorSchemeName = 'custom'
        DBState.db.colorScheme.uiColors = { binding: '#fce7f3', warning: '#78350f' }
        mounted = mount(CustomColorSchemeEditor, { target: document.body })
        await tick()
        const reset = document.querySelector<HTMLButtonElement>('[data-reset-ui-color="binding"]')
        expect(reset).not.toBeNull()
        reset!.click()
        await tick()

        expect(DBState.db.colorScheme.uiColors?.binding).toBeUndefined()
        expect(DBState.db.colorScheme.uiColors?.warning).toBe('#78350f')
        expect(updateColorScheme).toHaveBeenCalledOnce()
    })
})
