import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { darkColorScheme, lightColorScheme } from './colorschemePalettes'
import { MONACO_APP_THEME, resolveMonacoTheme } from './monacoTheme'
import { resolveUiThemeColors } from './uiThemeTokens'

describe('Monaco application theme', () => {
    test.each([
        [darkColorScheme, 'vs-dark'],
        [lightColorScheme, 'vs'],
    ] as const)('uses the $1 base and editable palette', (scheme, base) => {
        const theme = resolveMonacoTheme(scheme)
        const ui = resolveUiThemeColors(scheme)
        expect(theme.base).toBe(base)
        expect(theme.inherit).toBe(false)
        expect(theme.colors).toMatchObject({
            'editor.background': scheme.darkbg.toLowerCase(),
            'editor.foreground': scheme.textcolor.toLowerCase(),
            'editorGutter.background': scheme.darkbg.toLowerCase(),
            'editorCursor.foreground': scheme.primary.toLowerCase(),
            'editorLineNumber.foreground': scheme.textcolor2.toLowerCase(),
            'editor.selectionBackground': ui.binding,
            'editor.selectionForeground': ui['binding-text'],
            'editorWidget.background': scheme.bgcolor.toLowerCase(),
            'editorWidget.foreground': scheme.textcolor.toLowerCase(),
            'editorWidget.border': scheme.darkBorderc.toLowerCase(),
            'editorError.foreground': ui.danger,
            'editorWarning.foreground': ui.warning,
            'editorInfo.foreground': ui.info,
        })
    })

    test('maps syntax and widgets to overridden semantic roles without inherited fixed syntax colors', () => {
        const theme = resolveMonacoTheme({
            ...lightColorScheme,
            uiColors: {
                info: '#123456', success: '#234567', warning: '#345678',
                danger: '#456789', secondary: '#56789a',
                binding: '#abc', 'binding-text': '#123', 'binding-border': '#789abc',
            },
        })
        expect(theme.colors['editorSuggestWidget.selectedBackground']).toBe('#aabbcc')
        expect(theme.colors['editorSuggestWidget.selectedForeground']).toBe('#112233')
        expect(theme.rules).toEqual(expect.arrayContaining([
            expect.objectContaining({ token: 'type', foreground: '123456' }),
            expect.objectContaining({ token: 'string', foreground: '234567' }),
            expect.objectContaining({ token: 'number', foreground: '345678' }),
            expect.objectContaining({ token: 'invalid', foreground: '456789' }),
            expect.objectContaining({ token: 'keyword', foreground: '56789a' }),
        ]))
    })

    test('normalizes short hex and alpha colors to Monaco-compatible values', () => {
        const theme = resolveMonacoTheme({
            ...darkColorScheme,
            textcolor: '#ABC',
            uiColors: { info: '#ABCD', binding: '#12345678' },
        })
        expect(theme.colors['editor.foreground']).toBe('#aabbcc')
        expect(theme.colors['editorInfo.foreground']).toBe('#aabbccdd')
        expect(theme.colors['editor.selectionBackground']).toBe('#12345678')
        expect(theme.rules).toContainEqual(expect.objectContaining({ token: 'type', foreground: 'aabbcc' }))
        for (const color of Object.values(theme.colors)) expect(color).toMatch(/^#[\da-f]{6}(?:[\da-f]{2})?$/)
        for (const rule of theme.rules) {
            if (rule.foreground) expect(rule.foreground).toMatch(/^[\da-f]{6}$/)
            if (rule.background) expect(rule.background).toMatch(/^[\da-f]{6}$/)
        }
    })

    test('falls back to a legible mode palette for old or CSS-expression colors', () => {
        const theme = resolveMonacoTheme({
            type: 'light', darkbg: 'var(--surface)', textcolor: 'color-mix(in srgb, red, blue)',
            primary: 'invalid', textcolor2: '', uiColors: { info: 'var(--link)' },
        })
        expect(theme.base).toBe('vs')
        expect(theme.colors['editor.background']).toBe(lightColorScheme.darkbg)
        expect(theme.colors['editor.foreground']).toBe(lightColorScheme.textcolor)
        expect(theme.colors['editorCursor.foreground']).toBe(lightColorScheme.primary)
        expect(theme.colors['editorLineNumber.foreground']).toBe(lightColorScheme.textcolor2)
        expect(theme.colors['editorInfo.foreground']).toBe(resolveUiThemeColors(lightColorScheme).info)
        expect(resolveMonacoTheme().colors['editor.background']).toBe(darkColorScheme.darkbg)
    })

    test('reads each new palette snapshot without mutating persisted options', () => {
        const scheme = { ...lightColorScheme, uiColors: { info: '#123456' } }
        const original = structuredClone(scheme)
        expect(resolveMonacoTheme(scheme).colors['editorInfo.foreground']).toBe('#123456')
        expect(scheme).toEqual(original)
        scheme.uiColors.info = '#abcdef'
        scheme.darkbg = '#fafafa'
        expect(resolveMonacoTheme(scheme).colors).toMatchObject({
            'editorInfo.foreground': '#abcdef', 'editor.background': '#fafafa',
        })
    })

    test('wires reactive app colors while keeping explicit themes and lazy editor loading', () => {
        const component = readFileSync(join(process.cwd(), 'src/lib/Others/MonacoEditor.svelte'), 'utf8')
        const popup = readFileSync(join(process.cwd(), 'src/lib/Others/PopupEditor.svelte'), 'utf8')
        expect(MONACO_APP_THEME).toBe('risubard-app')
        expect(component).not.toContain("theme = 'vs-dark'")
        expect(component).toContain('theme: theme ?? MONACO_APP_THEME')
        expect(component).toMatch(/\$effect\(\(\) => \{[\s\S]*theme !== undefined[\s\S]*monaco\.editor\.setTheme\(theme\)[\s\S]*resolveMonacoTheme\(DBState\.db\.colorScheme\)[\s\S]*monaco\.editor\.defineTheme\(MONACO_APP_THEME, appTheme\)/)
        expect(popup).toContain("import('./MonacoEditor.svelte')")
    })
})
