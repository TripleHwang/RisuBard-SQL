import { describe, expect, test } from 'vitest'
import { darkColorScheme, lightColorScheme } from './colorschemePalettes'
import { resolveChatTextSurface, resolveTextTheme, textThemeFields, type TextThemeColors } from './textTheme'

const legacyCustom: TextThemeColors = {
    FontColorStandard: '#f8f8f2',
    FontColorItalic: '#8C8D93',
    FontColorBold: '#f8f8f2',
    FontColorItalicBold: '#8C8D93',
    FontColorQuote1: '#8BE9FD',
    FontColorQuote2: '#FFB86C',
}

const lightSurfaces = [lightColorScheme.bgcolor, lightColorScheme.darkbg, lightColorScheme.selected]
const darkSurfaces = [darkColorScheme.bgcolor, darkColorScheme.darkbg, darkColorScheme.selected]

function rgb(hex: string): number[] {
    const value = hex.slice(1)
    const expanded = value.length < 5 ? [...value].map((channel) => channel + channel).join('') : value
    return expanded.match(/.{2}/g)!.slice(0, 3).map((channel) => parseInt(channel, 16))
}

function contrast(first: number[], second: number[]): number {
    const luminance = (channels: number[]) => channels.reduce((sum, channel, index) => {
        const value = channel / 255
        return sum + (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
            * [0.2126, 0.7152, 0.0722][index]
    }, 0)
    const one = luminance(first)
    const two = luminance(second)
    return (Math.max(one, two) + 0.05) / (Math.min(one, two) + 0.05)
}

function expectLegible(colors: TextThemeColors, backgrounds: string[]) {
    expect(Object.keys(colors)).toHaveLength(6)
    for (const [key, value] of Object.entries(colors)) {
        const foreground = rgb(value)
        for (const surface of backgrounds) {
            const background = rgb(surface)
            expect(contrast(foreground, background), `${key} on ${surface}`).toBeGreaterThanOrEqual(4.5)
            if (key.startsWith('FontColorQuote')) {
                const tinted = background.map((channel, index) => channel * 0.9 + foreground[index] * 0.1)
                expect(contrast(foreground, tinted), `${key} on ${surface} quote tint`).toBeGreaterThanOrEqual(4.5)
            }
        }
    }
}

describe('text theme defaults', () => {
    test('preserves the standard dark palette exactly', () => {
        expect(resolveTextTheme('standard', 'dark')).toEqual({
            ...legacyCustom,
            FontColorStandard: '#fafafa',
            FontColorBold: '#fafafa',
        })
    })

    test('preserves the high-contrast dark palette exactly', () => {
        expect(resolveTextTheme('highcontrast', 'dark')).toEqual({
            ...legacyCustom,
            FontColorItalic: '#F1FA8C',
            FontColorBold: '#8BE9FD',
            FontColorItalicBold: '#FFB86C',
        })
    })

    test.each(['standard', 'highcontrast'])('preserves the current %s light palette', (theme) => {
        const colors = resolveTextTheme(theme, 'light')
        expect(colors).toEqual({
            FontColorStandard: '#0f172a',
            FontColorItalic: theme === 'standard' ? '#5b6474' : '#854d0e',
            FontColorBold: theme === 'standard' ? '#0f172a' : '#155e75',
            FontColorItalicBold: theme === 'standard' ? '#5b6474' : '#9a3412',
            FontColorQuote1: '#155e75',
            FontColorQuote2: '#9a3412',
        })
        expectLegible(colors, lightSurfaces)
    })

    test('falls back to standard for unknown saved text theme names', () => {
        expect(resolveTextTheme('legacy-unknown', 'light')).toEqual(resolveTextTheme('standard', 'light'))
        expect(resolveTextTheme('legacy-unknown', 'light').FontColorQuote2).toBe('#9a3412')
    })

    test('provides localized metadata for all six editable text colors', () => {
        expect(textThemeFields.map((field) => field.key)).toEqual(Object.keys(legacyCustom))
        for (const field of textThemeFields) {
            expect(field.label).toBeTruthy()
            expect(field.labelKo).toMatch(/[가-힣]/)
        }
    })
})

describe('custom text theme contrast', () => {
    test('makes legacy dark custom body and dialogue readable on light surfaces without mutating saved colors', () => {
        const custom = Object.freeze({ ...legacyCustom })
        const colors = resolveTextTheme('custom', 'light', custom, { backgrounds: lightSurfaces })

        expect(colors.FontColorQuote2).not.toBe('#FFB86C')
        expect(colors.FontColorStandard).not.toBe('#f8f8f2')
        expectLegible(colors, lightSurfaces)
        expect(custom).toEqual(legacyCustom)

        // Scaling toward black preserves the orange hue instead of replacing it with a preset hue.
        const [red, green, blue] = rgb(colors.FontColorQuote2)
        const hue = (green - blue) / (red - blue)
        expect(hue).toBeCloseTo((184 - 108) / (255 - 108), 1)
    })

    test('also corrects custom low-contrast colors on dark surfaces', () => {
        const colors = resolveTextTheme('custom', 'dark', { ...legacyCustom, FontColorQuote2: '#402008' }, {
            backgrounds: darkSurfaces,
        })

        expectLegible(colors, darkSurfaces)
    })

    test('preserves already legible custom colors exactly, including case and short hex', () => {
        const custom = {
            FontColorStandard: '#123',
            FontColorItalic: '#102A43',
            FontColorBold: '#1A2B3C',
            FontColorItalicBold: '#243B53',
            FontColorQuote1: '#004455',
            FontColorQuote2: '#663300',
        }

        expect(resolveTextTheme('custom', 'light', custom, { backgrounds: lightSurfaces })).toEqual(custom)
    })

    test('preserves readable stock custom dialogue on dark surfaces', () => {
        const colors = resolveTextTheme('custom', 'dark', legacyCustom, { backgrounds: darkSurfaces })

        expect(colors.FontColorQuote1).toBe('#8BE9FD')
        expect(colors.FontColorQuote2).toBe('#FFB86C')
        expectLegible(colors, darkSurfaces)
    })

    test('allows the user to disable all adjustment and retain exact custom colors', () => {
        expect(resolveTextTheme('custom', 'light', legacyCustom, {
            backgrounds: lightSurfaces,
            autoContrast: false,
        })).toEqual(legacyCustom)
    })

    test.each(['light', 'dark'] as const)('fills missing/null custom quotes from %s defaults', (type) => {
        const standard = resolveTextTheme('standard', type)
        const colors = resolveTextTheme('custom', type, { FontColorQuote1: null }, { autoContrast: false })

        expect(colors).toEqual(standard)
        expect(colors.FontColorQuote1).toBe(type === 'light' ? '#155e75' : '#8BE9FD')
        expect(colors.FontColorQuote2).toBe(type === 'light' ? '#9a3412' : '#FFB86C')
    })

    test('uses mode-appropriate surfaces when no usable background hex is supplied', () => {
        expectLegible(resolveTextTheme('custom', 'light', legacyCustom), lightSurfaces)
        expectLegible(resolveTextTheme('custom', 'light', legacyCustom, { backgrounds: ['var(--surface)'] }), lightSurfaces)
    })

    test('preserves non-hex CSS expressions and fills empty values defensively', () => {
        const colors = resolveTextTheme('custom', 'light', {
            FontColorStandard: 'var(--my-text)',
            FontColorItalic: 'rgb(10 20 30)',
            FontColorQuote1: '',
        })

        expect(colors.FontColorStandard).toBe('var(--my-text)')
        expect(colors.FontColorItalic).toBe('rgb(10 20 30)')
        expect(colors.FontColorQuote1).toBe('#155e75')
    })

    test('falls back to the mode default for malformed hex instead of emitting an invalid CSS color', () => {
        const colors = resolveTextTheme('custom', 'light', { FontColorQuote2: '#not-a-color' })

        expect(colors.FontColorQuote2).toBe('#9a3412')
    })

    test.each(['#f806', '#ff880044'])('makes low-opacity custom hex %s readable without changing stored data', (value) => {
        const custom = { ...legacyCustom, FontColorQuote2: value }
        const colors = resolveTextTheme('custom', 'light', custom)

        expect(colors.FontColorQuote2).toEqual(expect.stringMatching(/^#[0-9a-f]{6}$/i))
        expectLegible(colors, lightSurfaces)
        expect(custom.FontColorQuote2).toBe(value)
    })

    test('uses a bounded best-effort color when mixed surfaces cannot all meet 4.5 contrast', () => {
        const colors = resolveTextTheme('custom', 'light', { ...legacyCustom, FontColorQuote2: '#777777' }, {
            backgrounds: ['#000000', '#ffffff'],
        })
        expect(colors.FontColorQuote2).toEqual(expect.any(String))
        const foreground = rgb(colors.FontColorQuote2)
        const darkestTint = foreground.map((channel) => channel * 0.1)
        const lightestTint = foreground.map((channel) => 255 * 0.9 + channel * 0.1)

        // A quote-tinted pure black + pure white pair has no 4.5:1 solution.
        expect(Math.min(contrast(foreground, darkestTint), contrast(foreground, lightestTint))).toBeGreaterThan(3.8)
    })
})

describe('built-in text contrast on explicit rendered surfaces', () => {
    test.each(['standard', 'highcontrast'])('%s light text adapts to an actual dark backdrop', (theme) => {
        const colors = resolveTextTheme(theme, 'light', undefined, { backgrounds: darkSurfaces })

        expectLegible(colors, darkSurfaces)
    })

    test.each(['standard', 'highcontrast'])('%s dark text adapts to an actual light backdrop', (theme) => {
        const colors = resolveTextTheme(theme, 'dark', undefined, { backgrounds: lightSurfaces })

        expectLegible(colors, lightSurfaces)
    })

    test.each(['standard', 'highcontrast'])('%s opt-out keeps the exact built-in palette despite opposite surfaces', (theme) => {
        expect(resolveTextTheme(theme, 'light', undefined, { backgrounds: darkSurfaces, autoContrast: false }))
            .toEqual(resolveTextTheme(theme, 'light'))
        expect(resolveTextTheme(theme, 'dark', undefined, { backgrounds: lightSurfaces, autoContrast: false }))
            .toEqual(resolveTextTheme(theme, 'dark'))
    })
})

describe('active chat text surfaces', () => {
    test.each(['', '-', undefined])('ignores dormant textScreenColor with no active image (%s)', (customBackground) => {
        const surface = resolveChatTextSurface(lightColorScheme, {
            theme: '', customBackground, textScreenColor: '#121212',
        })

        expect(surface.active).toBe(false)
        expect(surface.background).toBe('')
        expect(surface.backgrounds).toEqual([lightColorScheme.bgcolor, lightColorScheme.darkbg])
        const colors = resolveTextTheme('custom', 'light', legacyCustom, { backgrounds: surface.backgrounds })
        expect(colors.FontColorQuote2).not.toBe('#FFB86C')
        expectLegible(colors, surface.backgrounds)
    })

    test.each(['waifu', 'waifuMobile'])('composites the active %s text backdrop at 50 percent', (theme) => {
        const scheme = { ...lightColorScheme, bgcolor: '#ffffff', darkbg: '#ffffff' }
        const surface = resolveChatTextSurface(scheme, { theme, textScreenColor: '#000000' })

        expect(surface.active).toBe(true)
        expect(surface.background).toBe('color-mix(in srgb, #000000 50%, transparent)')
        expect(surface.backgrounds).toEqual(['#808080', '#808080'])
    })

    test('activates the backdrop for a configured background image in standard view', () => {
        const surface = resolveChatTextSurface(lightColorScheme, {
            theme: '', customBackground: 'assets/background.webp', textScreenColor: '#000000',
        })

        expect(surface.active).toBe(true)
        expect(surface.backgrounds).toEqual(['#7c7c7c', '#808080'])
    })

    test('multiplies authored alpha by the 50 percent backdrop opacity', () => {
        const scheme = { ...lightColorScheme, bgcolor: '#ffffff', darkbg: '#ffffff' }
        const surface = resolveChatTextSurface(scheme, { theme: 'waifu', textScreenColor: '#00000080' })

        expect(surface.background).toBe('color-mix(in srgb, #00000080 50%, transparent)')
        expect(surface.backgrounds).toEqual(['#bfbfbf', '#bfbfbf'])
    })

    test('uses the skin background rather than black for the default translucent backdrop', () => {
        const scheme = { ...lightColorScheme, bgcolor: '#ffffff', darkbg: '#000000' }
        const surface = resolveChatTextSurface(scheme, { theme: 'waifu' })

        expect(surface.background).toBe('color-mix(in srgb, #ffffff 80%, transparent)')
        expect(surface.backgrounds).toEqual(['#ffffff', '#cccccc'])
    })
})
