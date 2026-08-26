import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/plugins/plugins.svelte.ts'), 'utf8')
const chatScreenSource = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/ChatScreen.svelte'), 'utf8')

describe('plugin readiness with metadata bootstrap', () => {
    it('publishes readiness after plugin loading settles', () => {
        expect(source).toContain('export const pluginReadyStore')
        expect(source).toContain("pluginStateStore.set('failed')")
        expect(source).toContain("pluginStateStore.set('ready')")
        expect(source).not.toMatch(/finally[\s\S]*pluginReadyStore\.set\(true\)/)
    })

    it('gates module UI for idle, loading, and failed plugin states', () => {
        expect(chatScreenSource).toContain('$pluginStateStore === \'idle\' || $pluginStateStore === \'loading\'')
        expect(chatScreenSource).toContain("$pluginStateStore === 'failed'")
        expect(chatScreenSource).toContain('Plugin initialization failed')
    })

    it('does not expose or replace metadata-only characters through v2 plugin APIs', () => {
        expect(source).toContain("character?.detailsLoaded === false ? null : character")
        expect(source).toContain("throw new Error('Character details are still loading')")
        expect(source).toContain("prop === 'characters' && hasMetadataOnlyCharacters(target)")
        expect(source).toMatch(/isPluginCharacterComplete[\s\S]*character\.chats\.every\(isPluginChatComplete\)/)
    })
})
