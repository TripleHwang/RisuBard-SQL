import type { editor } from 'monaco-editor'
import type { ColorScheme } from './colorscheme'
import { darkColorScheme, lightColorScheme } from './colorschemePalettes'
import { resolveUiThemeColors, type UiThemeColors } from './uiThemeTokens'

export const MONACO_APP_THEME = 'risubard-app'

// Monaco cannot resolve CSS variables/expressions, and syntax colors only accept
// expanded hex. Fall back per field so old/imported palettes remain readable.
function normalizeHex(value: unknown, fallback: string): string {
    const color = typeof value === 'string' && /^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value.trim())
        ? value.trim() : fallback
    const hex = color.slice(1).toLowerCase()
    return '#' + (hex.length < 5 ? [...hex].map((digit) => digit + digit).join('') : hex)
}

function translucent(color: string, opacity: number): string {
    const alpha = color.length === 9 ? parseInt(color.slice(7), 16) : 255
    return color.slice(0, 7) + Math.round(alpha * opacity).toString(16).padStart(2, '0')
}

type PaletteColor = Exclude<keyof ColorScheme, 'type' | 'baseScheme' | 'uiColors'>

export function resolveMonacoTheme(scheme?: Partial<ColorScheme> | null): editor.IStandaloneThemeData {
    const fallback = scheme?.type === 'light' ? lightColorScheme : darkColorScheme
    const core = (key: PaletteColor) => normalizeHex(scheme?.[key], fallback[key])
    const resolvedUi = resolveUiThemeColors({ ...fallback, ...scheme, type: fallback.type })
    const ui = Object.fromEntries(Object.entries(resolvedUi).map(([key, value]) => [key, normalizeHex(value, value)])) as UiThemeColors
    const foreground = core('textcolor')
    const background = core('darkbg')
    const muted = core('textcolor2')
    const border = core('darkBorderc')
    const colors: Record<string, string> = {
        'editor.background': background,
        'editor.foreground': foreground,
        'editorGutter.background': background,
        'editorCursor.foreground': core('primary'),
        'editorCursor.background': core('accentText'),
        'editorLineNumber.foreground': muted,
        'editorLineNumber.activeForeground': core('primary'),
        'editor.lineHighlightBackground': core('selected'),
        'editor.lineHighlightBorder': core('selected'),
        'editor.selectionBackground': ui.binding,
        'editor.selectionForeground': ui['binding-text'],
        'editor.inactiveSelectionBackground': translucent(ui.binding, 0.7),
        'editor.selectionHighlightBackground': translucent(ui.binding, 0.4),
        'editor.selectionHighlightBorder': ui['binding-border'],
        'editor.wordHighlightBackground': translucent(ui.binding, 0.4),
        'editor.wordHighlightBorder': ui['binding-border'],
        'editorWhitespace.foreground': translucent(muted, 0.4),
        'editorIndentGuide.background1': border,
        'editorIndentGuide.activeBackground1': core('borderc'),
        'editorBracketMatch.background': translucent(ui.secondary, 0.15),
        'editorBracketMatch.border': ui['secondary-border'],
        'editorLink.activeForeground': ui.info,
        'editor.findMatchBackground': ui['warning-bg'],
        'editor.findMatchForeground': ui.warning,
        'editor.findMatchBorder': ui['warning-border'],
        'editor.findMatchHighlightBackground': translucent(ui.warning, 0.2),
        'editorError.foreground': ui.danger,
        'editorWarning.foreground': ui.warning,
        'editorInfo.foreground': ui.info,
        'editorHint.foreground': muted,
        'editorOverviewRuler.errorForeground': ui.danger,
        'editorOverviewRuler.warningForeground': ui.warning,
        'editorOverviewRuler.infoForeground': ui.info,
        'editorOverviewRuler.background': background,
        'editorOverviewRuler.border': border,
        'editorHoverWidget.statusBarBackground': core('selected'),
        'editorSuggestWidget.selectedBackground': ui.binding,
        'editorSuggestWidget.selectedForeground': ui['binding-text'],
        'editorSuggestWidget.highlightForeground': ui.info,
        'editorSuggestWidget.focusHighlightForeground': ui['binding-text'],
        'editorSuggestWidgetStatus.foreground': muted,
        'editorInlayHint.background': core('selected'),
        'editorInlayHint.foreground': muted,
        'editorGhostText.foreground': muted,
        'editorCodeLens.foreground': muted,
        'input.background': core('darkbutton'),
        'input.foreground': foreground,
        'input.placeholderForeground': muted,
        'input.border': border,
        'focusBorder': core('primary'),
        'button.background': core('primary'),
        'button.foreground': core('accentText'),
        'button.hoverBackground': translucent(core('primary'), 0.85),
        'list.activeSelectionBackground': ui.binding,
        'list.activeSelectionForeground': ui['binding-text'],
        'list.focusBackground': ui.binding,
        'list.focusForeground': ui['binding-text'],
        'list.hoverBackground': core('selected'),
        'list.hoverForeground': foreground,
        'menu.selectionBackground': ui.binding,
        'menu.selectionForeground': ui['binding-text'],
        'menu.separatorBackground': border,
        'scrollbar.shadow': translucent(ui.shadow, 0.35),
        'scrollbarSlider.background': translucent(core('borderc'), 0.4),
        'scrollbarSlider.hoverBackground': translucent(core('borderc'), 0.6),
        'scrollbarSlider.activeBackground': translucent(core('borderc'), 0.8),
        'widget.shadow': translucent(ui.shadow, 0.35),
    }
    for (const widget of ['editorWidget', 'editorHoverWidget', 'editorSuggestWidget', 'dropdown', 'menu']) {
        colors[`${widget}.background`] = core('bgcolor')
        colors[`${widget}.foreground`] = foreground
        colors[`${widget}.border`] = border
    }
    for (const [index, color] of [ui.warning, ui.secondary, ui.info, ui.success, ui.danger, foreground].entries()) {
        colors[`editorBracketHighlight.foreground${index + 1}`] = color
    }
    // Monaco discards syntax alpha itself; pass normalized RGB explicitly and
    // do not inherit built-in rules that would reintroduce fixed child colors.
    const syntax = (token: string, color: string, fontStyle = '') => ({ token, foreground: color.slice(1, 7), fontStyle })
    return {
        base: fallback.type === 'light' ? 'vs' : 'vs-dark',
        inherit: false,
        colors,
        rules: [
            { ...syntax('', foreground), background: background.slice(1, 7) },
            syntax('comment', muted, 'italic'),
            syntax('keyword', ui.secondary),
            syntax('type', ui.info),
            syntax('function', ui.info),
            syntax('tag', ui.info),
            syntax('attribute.name', ui.warning),
            syntax('attribute.value', ui.success),
            syntax('string', ui.success),
            syntax('string.escape', ui.warning),
            syntax('string.link', ui.info, 'underline'),
            syntax('number', ui.warning),
            syntax('constant', ui.warning),
            syntax('regexp', ui.danger),
            syntax('delimiter', muted),
            syntax('operator', ui.info),
            syntax('metatag', ui.secondary),
            syntax('invalid', ui.danger, 'underline'),
            syntax('markup.heading', ui.info, 'bold'),
            syntax('strong', foreground, 'bold'),
            syntax('emphasis', ui.secondary, 'italic'),
        ],
    }
}
