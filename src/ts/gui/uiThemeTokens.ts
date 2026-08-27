import type { ColorScheme } from './colorscheme'

// Application chrome only. Authored card palettes and exported artwork are not skins.
export const uiThemeTokens = [
    { token: 'binding', group: 'binding', label: 'Bound / selected background', labelKo: '바인딩·고정 배경', dark: '#39456b', light: '#e0e7ff' },
    { token: 'binding-text', group: 'binding', label: 'Bound / selected text', labelKo: '바인딩·고정 글자', dark: '#e0e7ff', light: '#3730a3' },
    { token: 'binding-border', group: 'binding', label: 'Bound / selected border', labelKo: '바인딩·고정 테두리', dark: '#697ba8', light: '#a5b4fc' },
    { token: 'info', group: 'status', label: 'Information / links', labelKo: '정보·링크', dark: '#93c5fd', light: '#1e40af' },
    { token: 'info-bg', group: 'status', label: 'Information background', labelKo: '정보 배경', dark: '#172d48', light: '#eff6ff' },
    { token: 'info-border', group: 'status', label: 'Information border', labelKo: '정보 테두리', dark: '#3b5c82', light: '#93b4e8' },
    { token: 'on-info', group: 'status', label: 'Text on information fill', labelKo: '정보색 위 글자', dark: '#102033', light: '#ffffff' },
    { token: 'success', group: 'status', label: 'Success / positive', labelKo: '성공·긍정', dark: '#86efac', light: '#166534' },
    { token: 'success-bg', group: 'status', label: 'Success background', labelKo: '성공 배경', dark: '#12372b', light: '#f0fdf4' },
    { token: 'success-border', group: 'status', label: 'Success border', labelKo: '성공 테두리', dark: '#366e51', light: '#86bb9b' },
    { token: 'on-success', group: 'status', label: 'Text on success fill', labelKo: '성공색 위 글자', dark: '#10251b', light: '#ffffff' },
    { token: 'warning', group: 'status', label: 'Warning / attention', labelKo: '경고·주의', dark: '#fcd34d', light: '#854d0e' },
    { token: 'warning-bg', group: 'status', label: 'Warning background', labelKo: '경고 배경', dark: '#3a2d16', light: '#fffbeb' },
    { token: 'warning-border', group: 'status', label: 'Warning border', labelKo: '경고 테두리', dark: '#85672e', light: '#d4ab58' },
    { token: 'on-warning', group: 'status', label: 'Text on warning fill', labelKo: '경고색 위 글자', dark: '#2e2008', light: '#ffffff' },
    { token: 'danger', group: 'status', label: 'Error / destructive', labelKo: '오류·삭제', dark: '#fca5a5', light: '#991b1b' },
    { token: 'danger-bg', group: 'status', label: 'Error background', labelKo: '오류 배경', dark: '#42232a', light: '#fef2f2' },
    { token: 'danger-border', group: 'status', label: 'Error border', labelKo: '오류 테두리', dark: '#85515b', light: '#e8a0a0' },
    { token: 'on-danger', group: 'status', label: 'Text on error fill', labelKo: '오류색 위 글자', dark: '#35151b', light: '#ffffff' },
    { token: 'secondary', group: 'status', label: 'Secondary accent', labelKo: '보조 강조', dark: '#c4b5fd', light: '#6b21a8' },
    { token: 'secondary-bg', group: 'status', label: 'Secondary background', labelKo: '보조 강조 배경', dark: '#302542', light: '#faf5ff' },
    { token: 'secondary-border', group: 'status', label: 'Secondary border', labelKo: '보조 강조 테두리', dark: '#70608f', light: '#c4a0e4' },
    { token: 'on-secondary', group: 'status', label: 'Text on secondary fill', labelKo: '보조 강조색 위 글자', dark: '#221b32', light: '#ffffff' },
    { token: 'overlay', group: 'media', label: 'Backdrop / scrim', labelKo: '화면 가림·오버레이', dark: '#000000', light: '#000000' },
    { token: 'shadow', group: 'media', label: 'Shadow', labelKo: '그림자', dark: '#000000', light: '#000000' },
    { token: 'media-bg', group: 'media', label: 'Image overlay background', labelKo: '이미지 위 배경', dark: '#111827', light: '#111827' },
    { token: 'media-text', group: 'media', label: 'Image overlay text', labelKo: '이미지 위 글자', dark: '#ffffff', light: '#ffffff' },
    { token: 'switch-thumb', group: 'media', label: 'Switch thumb', labelKo: '스위치 손잡이', dark: '#ffffff', light: '#ffffff' },
] as const

export type UiThemeToken = typeof uiThemeTokens[number]['token']
export type UiThemeColors = Record<UiThemeToken, string>

export function resolveUiThemeColors(scheme: ColorScheme): UiThemeColors {
    const type = scheme.type === 'light' ? 'light' : 'dark'
    return Object.fromEntries(uiThemeTokens.map((field) => {
        const override = scheme.uiColors?.[field.token]
        // Swatches and exported overrides use hex. Reject invalid imports instead
        // of emitting values that invalidate every CSS declaration using a token.
        const valid = typeof override === 'string' && /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(override)
        return [field.token, valid ? override : field[type]]
    })) as UiThemeColors
}
