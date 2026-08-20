import { describe, expect, test } from 'vitest'
import type { Chat, RisuPersona, character } from './storage/database.svelte'
import {
    clonePersonaToStore,
    ensureCharacterPersonas,
    getCharacterPersonas,
    getEffectivePersona,
    nextPersonaCopyName,
    resolvePersonaById,
} from './personaScopes'

const persona = (name: string, id: string): RisuPersona => ({
    name,
    id,
    icon: `${id}.png`,
    personaPrompt: `${name} prompt`,
})

const owner = (personas?: RisuPersona[]): character => ({
    personas,
    chats: [],
    chatFolders: [],
    chatPage: 0,
} as unknown as character)

describe('persona scopes', () => {
    test('resolves a bound persona from the current character before the global store', () => {
        const global = persona('Global duplicate', 'same-id')
        const local = persona('Character persona', 'same-id')

        expect(resolvePersonaById({ personas: [global], selectedPersona: 0 }, owner([local]), 'same-id'))
            .toEqual({ persona: local, scope: 'character', index: 0 })
    })

    test('falls back to the global store for existing chat bindings', () => {
        const global = persona('Global persona', 'global-id')

        expect(resolvePersonaById({ personas: [global], selectedPersona: 0 }, owner(), 'global-id'))
            .toEqual({ persona: global, scope: 'global', index: 0 })
    })

    test('uses the selected global persona when the chat has no valid binding', () => {
        const first = persona('First', 'first-id')
        const selected = persona('Selected', 'selected-id')
        const chat = { bindedPersona: 'missing-id' } as Chat

        expect(getEffectivePersona(
            { personas: [first, selected], selectedPersona: 1 },
            owner(),
            chat,
        )).toEqual({ persona: selected, scope: 'global', index: 1 })
    })

    test('reads an absent character repository without mutating reactive state', () => {
        const character = owner()
        const store = getCharacterPersonas(character)

        expect(store).toEqual([])
        expect(character.personas).toBeUndefined()
    })

    test('initializes a character repository only for an explicit edit', () => {
        const character = owner()
        const store = ensureCharacterPersonas(character)

        expect(store).toEqual([])
        expect(character.personas).toBe(store)
    })

    test('numbers repeated persona clones and assigns a fresh stable id', () => {
        expect(nextPersonaCopyName('Writer', ['Writer', 'Writer 2', 'Other']))
            .toBe('Writer 3')
        expect(nextPersonaCopyName('Writer 2', ['Writer', 'Writer 2']))
            .toBe('Writer 3')

        const source = persona('Writer', 'source-id')
        const target = [source, persona('Writer 2', 'second-id')]
        const clone = clonePersonaToStore(source, target, () => 'clone-id')

        expect(clone).toMatchObject({ name: 'Writer 3', id: 'clone-id' })
        expect(target).toEqual([source, expect.objectContaining({ id: 'second-id' }), clone])
        expect(clone).not.toBe(source)
    })

    test('keeps the original name when cloning into a character store without a collision', () => {
        const source = persona('Writer', 'source-id')
        const target: RisuPersona[] = []

        expect(clonePersonaToStore(source, target, () => 'clone-id').name).toBe('Writer')
    })
})
