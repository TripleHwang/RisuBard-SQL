import { describe, expect, test, vi } from 'vitest'
import { lightColorScheme } from '../gui/colorschemePalettes'

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} }, selectedCharID: { subscribe: () => () => {} }, selIdState: { selId: -1 },
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null }, downloadFile: vi.fn(), saveAsset: vi.fn(async () => ''),
}))
vi.mock('../alert', () => ({ notifySuccess: vi.fn(), alertError: vi.fn() }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: vi.fn() }))
vi.mock('../gui/colorscheme', async () => ({
    defaultColorScheme: (await import('../gui/colorschemePalettes')).darkColorScheme,
}))

const { getDatabase, setDatabase, saveCurrentThemePreset, changeToThemePreset } = await import('./database.svelte')

function initialize() {
    setDatabase({
        characters: [], formatingOrder: ['main'], loreBook: [], personas: [],
        username: 'User', userIcon: '', userNote: '',
        colorSchemeName: 'custom',
        colorScheme: { ...lightColorScheme, baseScheme: 'light', uiColors: { binding: '#aabbcc80', 'binding-text': '#123456' } },
        textTheme: 'custom', textThemeAutoContrast: false,
        customTextTheme: { FontColorQuote2: '#FFB86C' },
    } as Parameters<typeof setDatabase>[0])
}

describe('editable theme persistence', () => {
    test('keeps exact overrides and opt-out through a saved database round trip', () => {
        initialize()
        setDatabase(JSON.parse(JSON.stringify(getDatabase())))
        expect(getDatabase()).toMatchObject({
            colorSchemeName: 'custom', textThemeAutoContrast: false,
            colorScheme: { baseScheme: 'light', uiColors: { binding: '#aabbcc80', 'binding-text': '#123456' } },
            customTextTheme: { FontColorQuote2: '#FFB86C' },
        })
    })

    test('theme presets snapshot and restore role colors and the contrast preference', () => {
        initialize()
        saveCurrentThemePreset()
        const db = getDatabase()
        const index = db.themePresetsId
        db.colorScheme.uiColors!.binding = '#ffffff'
        db.textThemeAutoContrast = true
        db.themePresets = JSON.parse(JSON.stringify(db.themePresets))
        changeToThemePreset(index, false)
        expect(db.colorScheme.uiColors?.binding).toBe('#aabbcc80')
        expect(db.textThemeAutoContrast).toBe(false)
        expect(db.customTextTheme.FontColorQuote2).toBe('#FFB86C')
    })

    test('legacy presets without the preference enable readable text by default', () => {
        initialize()
        saveCurrentThemePreset()
        const db = getDatabase()
        delete db.themePresets[db.themePresetsId].textThemeAutoContrast
        changeToThemePreset(db.themePresetsId, false)
        expect(db.textThemeAutoContrast).toBe(true)
    })
})
