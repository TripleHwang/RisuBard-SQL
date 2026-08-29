import { describe, expect, test } from 'vitest'
import {
    buildArcaLogClipboardHtml,
    buildArcaLogPlainText,
    selectArcaLogMessages,
    type ArcaLogRenderedMessage,
} from './arcaChatLog'

describe('Arca chat log message selection', () => {
    const messages = [
        { data: 'greeting', role: 'char' as const },
        { data: 'hello', role: 'user' as const },
        { data: 'hidden', role: 'char' as const, disabled: true },
        { data: 'note', role: 'char' as const, isComment: true },
        { data: 'answer', role: 'char' as const },
        { data: 'follow-up', role: 'user' as const },
    ]

    test('whole-chat mode keeps only active conversation messages', () => {
        const selected = selectArcaLogMessages(messages, { mode: 'all' })

        expect(selected.map(item => [item.number, item.message.data])).toEqual([
            [1, 'greeting'],
            [2, 'hello'],
            [3, 'answer'],
            [4, 'follow-up'],
        ])
    })

    test('range mode uses inclusive one-based numbers after filtering', () => {
        const selected = selectArcaLogMessages(messages, { mode: 'range', start: 2, end: 3 })

        expect(selected.map(item => [item.number, item.message.data])).toEqual([
            [2, 'hello'],
            [3, 'answer'],
        ])
    })

    test('range values are clamped and reversed input is normalized', () => {
        const selected = selectArcaLogMessages(messages, { mode: 'range', start: 99, end: -4 })

        expect(selected.map(item => item.message.data)).toEqual([
            'greeting',
            'hello',
            'answer',
            'follow-up',
        ])
    })

    test('messages that render as blank placeholders are not exported', () => {
        const selected = selectArcaLogMessages([
            { data: '{{none}}', role: 'char' as const },
            { data: '   ', role: 'user' as const },
            { data: '{{blank}}', role: 'char' as const },
            { data: 'visible', role: 'char' as const },
        ], { mode: 'all' })

        expect(selected.map(item => item.message.data)).toEqual(['visible'])
    })
})

describe('Arca chat log clipboard composition', () => {
    const rendered: ArcaLogRenderedMessage[] = [
        {
            number: 1,
            role: 'char',
            displayName: 'Alice <Admin>',
            badge: 'Model & One',
            iconDataUrl: 'data:image/png;base64,AAA',
            bodyHtml: '<p>First <strong>reply</strong></p>',
            plainText: 'First reply',
        },
        {
            number: 2,
            role: 'user',
            displayName: 'User',
            iconDataUrl: 'data:image/png;base64,BBB',
            bodyHtml: '<p>Second message</p>',
            plainText: 'Second message',
        },
    ]

    test('builds one polished document with escaped labels and one footer', () => {
        const html = buildArcaLogClipboardHtml({
            title: 'Chat <One>',
            messages: rendered,
            showTitleImage: true,
        })

        expect(html).toContain('Chat &lt;One&gt;')
        expect(html).toContain('Alice &lt;Admin&gt;')
        expect(html).toContain('Model &amp; One')
        expect(html).toContain('<p>First <strong>reply</strong></p>')
        expect(html.match(/From RisuBard/g)).toHaveLength(1)
        expect(html.match(/data:image\/png;base64,/g)).toHaveLength(2)
    })

    test('omits profile images when the shared setting is disabled', () => {
        const html = buildArcaLogClipboardHtml({
            title: 'Chat',
            messages: rendered,
            showTitleImage: false,
        })

        expect(html).not.toContain('data:image/png;base64,')
    })

    test('builds readable plain text in message order', () => {
        expect(buildArcaLogPlainText('Chat One', rendered)).toBe(
            'Chat One\n\n1. Alice <Admin> · Model & One\nFirst reply\n\n2. User\nSecond message',
        )
    })
})
