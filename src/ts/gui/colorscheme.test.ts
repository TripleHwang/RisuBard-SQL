import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
    builtInColorSchemes,
    darkColorScheme,
    normalizeColorSchemeName,
    pastelPopColorScheme,
    resolveBuiltInColorScheme,
} from './colorschemePalettes'

function relativeLuminance(hex: string): number {
    const channels = hex.slice(1).match(/.{2}/g)?.map((channel) => parseInt(channel, 16) / 255) ?? []
    const [red, green, blue] = channels.map((channel) =>
        channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    )
    return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue)
}

function contrastRatio(first: string, second: string): number {
    const firstLuminance = relativeLuminance(first)
    const secondLuminance = relativeLuminance(second)
    return (Math.max(firstLuminance, secondLuminance) + 0.05)
        / (Math.min(firstLuminance, secondLuminance) + 0.05)
}

describe('built-in dark color scheme', () => {
    test('uses the modern midnight palette', () => {
        expect(darkColorScheme).toEqual({
            bgcolor: '#292D3E',
            darkbg: '#202331',
            borderc: '#7C86A8',
            selected: '#3A4054',
            draculared: '#FF7A72',
            textcolor: '#F7F8FC',
            textcolor2: '#AEB6CC',
            darkBorderc: '#454B61',
            darkbutton: '#33394B',
            primary: '#5B8CFF',
            accentText: '#F7F8FC',
            type: 'dark',
        })
    })

    test('keeps body, muted, and accent text legible on dark surfaces', () => {
        expect(contrastRatio(darkColorScheme.textcolor, darkColorScheme.bgcolor)).toBeGreaterThanOrEqual(7)
        expect(contrastRatio(darkColorScheme.textcolor2, darkColorScheme.bgcolor)).toBeGreaterThanOrEqual(4.5)
        expect(contrastRatio(darkColorScheme.primary, darkColorScheme.darkbg)).toBeGreaterThanOrEqual(4.5)
    })

    test('refreshes saved dark selections to the current built-in palette', () => {
        const staleDarkScheme = { ...darkColorScheme, bgcolor: '#1A1A1A' }

        const resolved = resolveBuiltInColorScheme('dark', staleDarkScheme)

        expect(resolved).toEqual(darkColorScheme)
        expect(resolved).not.toBe(darkColorScheme)
    })
})

describe('selectable color schemes', () => {
    test('only exposes Dark, Light, and Pastel Pop as built-in choices', () => {
        expect(Object.keys(builtInColorSchemes)).toEqual(['dark', 'light', 'pastel-pop'])
    })

    test('keeps the modern dark shell and adds bright accents with charcoal accent text', () => {
        expect(pastelPopColorScheme).toEqual({
            bgcolor: '#292D3E',
            darkbg: '#202331',
            borderc: '#8FD8F4',
            selected: '#C8A4F4',
            draculared: '#FF9A6C',
            textcolor: '#F7F8FC',
            textcolor2: '#AEB6CC',
            darkBorderc: '#454B61',
            darkbutton: '#FFE071',
            primary: '#A6ED68',
            accentText: '#242631',
            type: 'dark',
        })

        for(const accent of [
            pastelPopColorScheme.borderc,
            pastelPopColorScheme.selected,
            pastelPopColorScheme.draculared,
            pastelPopColorScheme.darkbutton,
            pastelPopColorScheme.primary,
        ]){
            expect(contrastRatio(pastelPopColorScheme.accentText, accent)).toBeGreaterThanOrEqual(7)
        }
        expect(contrastRatio(pastelPopColorScheme.textcolor, pastelPopColorScheme.bgcolor)).toBeGreaterThanOrEqual(7)
        expect(contrastRatio(pastelPopColorScheme.textcolor2, pastelPopColorScheme.bgcolor)).toBeGreaterThanOrEqual(4.5)
    })

    test('migrates removed built-in selections to Dark while preserving Custom', () => {
        expect(normalizeColorSchemeName('catppuccin-mocha')).toBe('dark')
        expect(resolveBuiltInColorScheme('catppuccin-mocha', pastelPopColorScheme)).toEqual(darkColorScheme)
        expect(normalizeColorSchemeName('custom')).toBe('custom')
        expect(resolveBuiltInColorScheme('custom', pastelPopColorScheme)).toBe(pastelPopColorScheme)
    })

    test('keeps every removed palette in the backup folder', () => {
        const archive = JSON.parse(readFileSync(
            join(process.cwd(), 'palette-backup', 'archived-color-schemes.json'),
            'utf8',
        )) as { palettes: Record<string, unknown> }

        expect(Object.keys(archive.palettes)).toEqual([
            'default',
            'realblack',
            'monokai-light',
            'monokai-black',
            'catppuccin-mocha',
            'catppuccin-macchiato',
            'catppuccin-frappe',
            'catppuccin-latte',
            'gruvbox-dark',
            'gruvbox-light',
            'cherry',
            'galaxy',
            'nature',
            'lite',
        ])
    })

    test('uses the accent foreground token on every bright accent surface', () => {
        const runtimeSource = readFileSync(join(process.cwd(), 'src', 'ts', 'gui', 'colorscheme.ts'), 'utf8')
        const stylesSource = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8')

        expect(runtimeSource).toContain('document.documentElement.dataset.risuColorScheme = appliedSchemeName')
        expect(runtimeSource).toContain('"--risu-theme-accenttext", colorScheme.accentText')
        expect(stylesSource).toContain('--color-accenttext: var(--risu-theme-accenttext)')
        expect(stylesSource).toContain(':is(.bg-primary, .bg-darkbutton, .bg-selected, .bg-borderc, .bg-draculared)')
    })
})
