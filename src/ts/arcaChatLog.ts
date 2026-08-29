import {
    normalizeArcaChatFontSizePx,
    normalizeArcaChatShowTitleImage,
} from './arcaChatSaverSettings'
import type { ArcaClipboardColors } from './arcaExport'

export type ArcaLogRange =
    | { mode: 'all' }
    | { mode: 'range'; start: number; end: number }

export interface ArcaLogSelectableMessage {
    data?: string
    disabled?: boolean | 'allBefore'
    isComment?: boolean
}

export interface ArcaLogSelection<T> {
    number: number
    message: T
}

export interface ArcaLogRenderedMessage {
    number: number
    role: 'user' | 'char'
    displayName: string
    badge?: string
    iconDataUrl?: string
    bodyHtml: string
    plainText: string
}

export interface ArcaLogClipboardHtmlOptions {
    title: string
    messages: readonly ArcaLogRenderedMessage[]
    fontSizePx?: number
    showTitleImage?: boolean
    colors?: Partial<ArcaClipboardColors>
}

const DEFAULT_COLORS: ArcaClipboardColors = {
    background: '#292d3e',
    panel: '#202331',
    text: '#f7f8fc',
    mutedText: '#aeb6cc',
    border: '#454b61',
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

export function selectArcaLogMessages<T extends ArcaLogSelectableMessage>(
    messages: readonly T[],
    range: ArcaLogRange,
): ArcaLogSelection<T>[] {
    const active = messages.filter((message) => {
        if (message.disabled || message.isComment) return false
        if (typeof message.data !== 'string') return true
        const data = message.data.trim()
        return data !== '' && data !== '{{none}}' && data !== '{{blank}}'
    })
    if (range.mode === 'all' || active.length === 0) {
        return active.map((message, index) => ({ number: index + 1, message }))
    }

    const clamp = (value: number) => Math.min(active.length, Math.max(1, Math.trunc(value) || 1))
    const first = clamp(range.start)
    const last = clamp(range.end)
    const start = Math.min(first, last)
    const end = Math.max(first, last)

    return active
        .slice(start - 1, end)
        .map((message, index) => ({ number: start + index, message }))
}

export function buildArcaLogClipboardHtml(options: ArcaLogClipboardHtmlOptions): string {
    const colors = { ...DEFAULT_COLORS, ...options.colors }
    const fontSizePx = normalizeArcaChatFontSizePx(options.fontSizePx)
    const showTitleImage = normalizeArcaChatShowTitleImage(options.showTitleImage)
    const title = escapeHtml(options.title)

    const messageHtml = options.messages.map((message) => {
        const name = escapeHtml(message.displayName)
        const badge = message.badge ? escapeHtml(message.badge) : ''
        const icon = showTitleImage && message.iconDataUrl
            ? `<img src="${escapeHtml(message.iconDataUrl)}" alt="" style="display:block;width:48px;height:48px;max-width:48px;object-fit:cover;border:1px solid ${colors.border};border-radius:12px;">`
            : ''
        const badgeHtml = badge
            ? `<span style="display:inline-block;margin-left:8px;padding:2px 8px;color:${colors.mutedText};background:${colors.background};border:1px solid ${colors.border};border-radius:999px;font-size:11px;line-height:1.4;vertical-align:middle;">${badge}</span>`
            : ''

        return `<section style="margin:0 0 14px 0;overflow:hidden;background:${colors.background};border:1px solid ${colors.border};border-radius:12px;">
<table style="width:100%;border-collapse:collapse;background:${colors.panel};"><tbody><tr>
${icon ? `<td style="width:64px;padding:12px 0 12px 14px;vertical-align:middle;">${icon}</td>` : ''}
<td style="padding:12px 14px;vertical-align:middle;">
<span style="display:inline-block;min-width:24px;margin-right:8px;color:${colors.mutedText};font-size:11px;font-variant-numeric:tabular-nums;">${String(message.number).padStart(2, '0')}</span>
<strong style="color:${colors.text};font-size:15px;font-weight:650;">${name}</strong>${badgeHtml}
</td>
</tr></tbody></table>
<div style="padding:16px 18px;color:${colors.text};">${message.bodyHtml}</div>
</section>`
    }).join('\n')

    return `<div style="margin:1rem 0;color:${colors.text};background:${colors.background};border:1px solid ${colors.border};border-radius:16px;font-family:'Segoe UI',Roboto,Arial,sans-serif;font-size:${fontSizePx}px;line-height:1.6;">
<div style="padding:22px;">
<header style="margin:0 0 20px 0;padding:0 0 16px 0;border-bottom:1px solid ${colors.border};">
<span style="display:block;margin-bottom:5px;color:${colors.mutedText};font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;">RisuBard Chat Log</span>
<h2 style="margin:0;color:${colors.text};font-size:24px;font-weight:700;line-height:1.3;">${title}</h2>
<span style="display:block;margin-top:6px;color:${colors.mutedText};font-size:12px;">${options.messages.length} messages</span>
</header>
${messageHtml}
<footer style="margin-top:18px;padding-top:14px;border-top:1px solid ${colors.border};text-align:center;">
<span style="color:${colors.mutedText};font-size:11px;">From RisuBard</span>
</footer>
</div>
</div>
<p><br></p>`
}

export function buildArcaLogPlainText(
    title: string,
    messages: readonly ArcaLogRenderedMessage[],
): string {
    const bodies = messages.map((message) => {
        const badge = message.badge ? ` · ${message.badge}` : ''
        return `${message.number}. ${message.displayName}${badge}\n${message.plainText}`
    })
    return [title, ...bodies].join('\n\n')
}
