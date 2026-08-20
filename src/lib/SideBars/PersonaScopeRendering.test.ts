import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('persona scope rendering', () => {
    test('includes the requested Solar Bold Earth icon', () => {
        const icons = source('src/lib/UI/Icons/SolarBoldIcon.svelte')

        expect(icons).toContain("| 'earth'")
        expect(icons).toContain("name === 'earth'")
    })

    test('badges the effective main-sidebar persona with its storage scope', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')

        expect(sidebar).toContain('getEffectivePersona')
        expect(sidebar).toContain('data-persona-scope-badge')
        expect(sidebar).toContain("effectivePersona?.scope === 'character' ? 'people-nearby' : 'earth'")
        expect(sidebar).toContain('effectivePersona?.persona.icon')
    })

    test('resolves character-owned bindings in chat message identity rendering', () => {
        const chat = source('src/lib/ChatScreens/DefaultChatScreen.svelte')

        expect(chat).toContain('resolvePersonaById')
        expect(chat).toContain('getEffectivePersona')
        expect(chat).not.toContain('DBState.db.personas.find((p) => p.id === bindedPersona)')
    })
})
