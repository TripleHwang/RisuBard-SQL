import type { ColorScheme } from './colorscheme'

export const darkColorScheme: ColorScheme = {
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
}

export const lightColorScheme: ColorScheme = {
    bgcolor: '#f7f7f8',
    darkbg: '#ffffff',
    borderc: '#9ca3af',
    selected: '#f3f4f6',
    draculared: '#dc2626',
    textcolor: '#202123',
    textcolor2: '#6b7280',
    darkBorderc: '#e5e7eb',
    darkbutton: '#f3f4f6',
    primary: '#2563eb',
    accentText: '#ffffff',
    type: 'light',
}

export const pastelPopColorScheme: ColorScheme = {
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
}

export const builtInColorSchemes = {
    dark: darkColorScheme,
    light: lightColorScheme,
    'pastel-pop': pastelPopColorScheme,
} as const

export type BuiltInColorSchemeName = keyof typeof builtInColorSchemes

export function normalizeColorSchemeName(name: string): BuiltInColorSchemeName | 'custom' {
    if(name === 'custom') return 'custom'
    if(name in builtInColorSchemes) return name as BuiltInColorSchemeName
    return 'dark'
}

export function resolveBuiltInColorScheme(name: string, stored: ColorScheme): ColorScheme {
    const normalizedName = normalizeColorSchemeName(name)
    if(normalizedName === 'custom') return stored
    return { ...builtInColorSchemes[normalizedName] }
}
