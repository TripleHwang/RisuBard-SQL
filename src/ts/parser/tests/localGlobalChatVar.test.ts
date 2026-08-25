import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('per-chat global variable compatibility', () => {
    test('preserves falsy local values and falls back only when absent', () => {
        const source = readFileSync('src/ts/parser/chatVar.svelte.ts', 'utf8')
        expect(source).toContain('localValue !== undefined')
        expect(source).toContain('chat?.useLocallySetGlobalVariables')
        expect(source).toContain('delete chat.GLGlobalVariables[key]')
    })

    test('routes all sidebar toggle field kinds through the scoped accessors', () => {
        const source = readFileSync('src/lib/SideBars/Toggles.svelte', 'utf8')
        expect(source).toContain('setGlobalChatVar(`toggle_${toggle.key}`')
        expect(source).toContain('getGlobalChatVarValue(`toggle_${toggle.key}`)')
        expect(source).toContain('currentChat.useLocallySetGlobalVariables = checked')
    })
})
