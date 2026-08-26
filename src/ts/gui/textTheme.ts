import { darkColorScheme, lightColorScheme } from './colorschemePalettes'

export interface TextThemeColors {
    FontColorStandard: string
    FontColorItalic: string
    FontColorBold: string
    FontColorItalicBold: string
    FontColorQuote1: string
    FontColorQuote2: string
}

export function resolveChatTextSurface(
    scheme: { type: 'light' | 'dark'; bgcolor: string; darkbg: string },
    settings: { theme?: string; customBackground?: string | null; textScreenColor?: string | null } = {},
): { active: boolean; background: string; backgrounds: string[] } {
    const backgrounds = [scheme.bgcolor, scheme.darkbg]
    // getCustomBackground() treats empty and one-character sentinel values as no image.
    const active = settings.theme === 'waifu' || settings.theme === 'waifuMobile'
        || (settings.customBackground?.length ?? 0) >= 2
    if (!active) return { active, background: '', backgrounds }

    const custom = settings.textScreenColor?.trim()
    const color = custom || scheme.bgcolor
    const opacity = custom ? 0.5 : 0.8
    const tint = parseHex(color)
    const fallback = parseHex((scheme.type === 'light' ? lightColorScheme : darkColorScheme).bgcolor)!.rgb
    return {
        active,
        background: `color-mix(in srgb, ${color} ${opacity * 100}%, transparent)`,
        // Image pixels are unknown. Estimate the translucent backdrop over the
        // skin's solid surfaces; this does not guarantee contrast over every image.
        backgrounds: backgrounds.map((surface) => {
            const parsed = parseHex(surface)
            if (!tint || !parsed) return surface
            const base = composite(parsed.rgb, fallback, parsed.alpha)
            const mixed = composite(tint.rgb, base, tint.alpha * opacity)
            return '#' + mixed.map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')
        }),
    }
}

export const textThemeFields = [
    { key: 'FontColorStandard', label: 'Normal Text', labelKo: '기본 글자' },
    { key: 'FontColorItalic', label: 'Italic Text', labelKo: '기울임 글자' },
    { key: 'FontColorBold', label: 'Bold Text', labelKo: '굵은 글자' },
    { key: 'FontColorItalicBold', label: 'Italic Bold Text', labelKo: '굵은 기울임 글자' },
    { key: 'FontColorQuote1', label: 'Single Quote Text', labelKo: '작은따옴표 대사' },
    { key: 'FontColorQuote2', label: 'Double Quote Text', labelKo: '큰따옴표 대사' },
] as const satisfies readonly { key: keyof TextThemeColors; label: string; labelKo: string }[]

type RGB = [number, number, number]
type HexColor = { rgb: RGB; alpha: number }

function parseHex(value: unknown): HexColor | null {
    if (typeof value !== 'string') return null
    let hex = value.trim().replace(/^#/, '')
    if (!value.trim().startsWith('#') || !/^(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(hex)) return null
    if (hex.length < 5) hex = [...hex].map((channel) => channel + channel).join('')
    return {
        rgb: [0, 2, 4].map((index) => parseInt(hex.slice(index, index + 2), 16)) as RGB,
        alpha: hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1,
    }
}

function composite(foreground: RGB, background: RGB, alpha: number): RGB {
    return foreground.map((channel, index) => channel * alpha + background[index] * (1 - alpha)) as RGB
}

function luminance(rgb: RGB): number {
    return rgb.reduce((sum, channel, index) => {
        const value = channel / 255
        const linear = value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
        return sum + linear * [0.2126, 0.7152, 0.0722][index]
    }, 0)
}

function contrast(foreground: RGB, background: RGB): number {
    const first = luminance(foreground)
    const second = luminance(background)
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function minimumContrast(color: HexColor, backgrounds: RGB[], quote: boolean): number {
    let minimum = Infinity
    for (const background of backgrounds) {
        minimum = Math.min(minimum, contrast(composite(color.rgb, background, color.alpha), background))
        if (quote) {
            // Matches the quote block's transparent 90% / foreground 10% tint.
            const tinted = composite(color.rgb, background, color.alpha * 0.1)
            minimum = Math.min(minimum, contrast(composite(color.rgb, tinted, color.alpha), tinted))
        }
    }
    return minimum
}

function ensureContrast(value: string, backgrounds: RGB[], quote: boolean): string {
    const parsed = parseHex(value)
    // CSS variables, named colors and expressions require the browser's cascade;
    // this pure resolver preserves them rather than guessing their actual color.
    if (!parsed) return value
    let bestContrast = minimumContrast(parsed, backgrounds, quote)
    if (bestContrast >= 4.5) return value
    let bestValue = value

    // Blending toward an achromatic endpoint preserves hue. Check the rounded
    // output itself, and make adjusted low-opacity hex colors opaque for legibility.
    // Mixed light/dark surfaces can have no 4.5:1 solution; retain the best bounded
    // candidate instead of looping indefinitely or claiming an impossible guarantee.
    for (let step = 0; step <= 255; step++) {
        for (const target of [0, 255]) {
            const rgb = parsed.rgb.map((channel) => Math.round(channel + (target - channel) * step / 255)) as RGB
            const candidateContrast = minimumContrast({ rgb, alpha: 1 }, backgrounds, quote)
            const candidate = '#' + rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')
            if (candidateContrast >= 4.5) return candidate
            if (candidateContrast > bestContrast) {
                bestContrast = candidateContrast
                bestValue = candidate
            }
        }
    }
    return bestValue
}

export function resolveTextTheme(
    theme: string,
    type: 'light' | 'dark',
    custom?: Partial<Record<keyof TextThemeColors, string | null>> | null,
    options: { autoContrast?: boolean; backgrounds?: string[] } = {},
): TextThemeColors {
    const standard: TextThemeColors = type === 'light' ? {
        FontColorStandard: '#0f172a',
        FontColorItalic: '#5b6474',
        FontColorBold: '#0f172a',
        FontColorItalicBold: '#5b6474',
        FontColorQuote1: '#155e75',
        FontColorQuote2: '#9a3412',
    } : {
        FontColorStandard: '#fafafa',
        FontColorItalic: '#8C8D93',
        FontColorBold: '#fafafa',
        FontColorItalicBold: '#8C8D93',
        FontColorQuote1: '#8BE9FD',
        FontColorQuote2: '#FFB86C',
    }

    let builtIn = standard
    if (theme === 'highcontrast') {
        builtIn = type === 'light' ? {
            ...standard,
            FontColorItalic: '#854d0e',
            FontColorBold: '#155e75',
            FontColorItalicBold: '#9a3412',
        } : {
            ...standard,
            FontColorStandard: '#f8f8f2',
            FontColorItalic: '#F1FA8C',
            FontColorBold: '#8BE9FD',
            FontColorItalicBold: '#FFB86C',
        }
    }
    // Default palette queries remain exact. Render-time calls can supply the
    // actual surfaces, which may differ from the skin's light/dark mode.
    if (theme !== 'custom' && (options.backgrounds === undefined || options.autoContrast === false)) return builtIn

    const palette = type === 'light' ? lightColorScheme : darkColorScheme
    const base = parseHex(palette.bgcolor)!.rgb
    const defaults = [palette.bgcolor, palette.darkbg, palette.selected]
    const parseBackgrounds = (values: string[]) => values.flatMap((value) => {
        const parsed = parseHex(value)
        return parsed ? [composite(parsed.rgb, base, parsed.alpha)] : []
    })
    const supplied = parseBackgrounds(options.backgrounds ?? defaults)
    const backgrounds = supplied.length ? supplied : parseBackgrounds(defaults)

    return Object.fromEntries(textThemeFields.map(({ key }) => {
        const saved = theme === 'custom' ? custom?.[key] : undefined
        const usable = typeof saved === 'string' && saved.trim()
            && (!saved.trim().startsWith('#') || parseHex(saved))
        const value = usable ? saved : builtIn[key]
        return [key, options.autoContrast === false ? value : ensureContrast(value, backgrounds, key.startsWith('FontColorQuote'))]
    })) as unknown as TextThemeColors
}

