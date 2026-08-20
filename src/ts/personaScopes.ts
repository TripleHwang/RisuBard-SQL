import type { Chat, RisuPersona, character } from './storage/database.svelte'

export type PersonaScope = 'global' | 'character'

export interface PersonaSelection {
    persona: RisuPersona
    scope: PersonaScope
    index: number
}

export interface PersonaDatabaseView {
    personas: RisuPersona[]
    selectedPersona: number
}

export function getCharacterPersonas(character?: character | null): RisuPersona[] {
    return character?.personas ?? []
}

export function ensureCharacterPersonas(character: character): RisuPersona[] {
    character.personas ??= []
    return character.personas
}

export function resolvePersonaById(
    db: PersonaDatabaseView,
    character: character | null | undefined,
    id: string | null | undefined,
): PersonaSelection | null {
    if (!id) return null

    const characterIndex = character?.personas?.findIndex((persona) => persona.id === id) ?? -1
    if (characterIndex >= 0) {
        return {
            persona: character.personas![characterIndex],
            scope: 'character',
            index: characterIndex,
        }
    }

    const globalIndex = db.personas.findIndex((persona) => persona.id === id)
    if (globalIndex < 0) return null
    return { persona: db.personas[globalIndex], scope: 'global', index: globalIndex }
}

export function getEffectivePersona(
    db: PersonaDatabaseView,
    character?: character | null,
    chat?: Pick<Chat, 'bindedPersona'> | null,
): PersonaSelection | null {
    const bound = resolvePersonaById(db, character, chat?.bindedPersona)
    if (bound) return bound

    const index = Math.min(Math.max(db.selectedPersona ?? 0, 0), db.personas.length - 1)
    const persona = db.personas[index]
    return persona ? { persona, scope: 'global', index } : null
}

export function nextPersonaCopyName(name: string, reservedNames: Iterable<string>): string {
    const normalizedName = name.trim() || 'New Persona'
    const reserved = new Set(reservedNames)
    if (!reserved.has(normalizedName)) return normalizedName
    const match = /^(.*?)(?:\s+(\d+))?$/.exec(normalizedName)
    const baseName = match?.[1]?.trim() || normalizedName
    const sourceNumber = match?.[2] ? Number(match[2]) : 1
    let number = Math.max(2, sourceNumber + 1)
    let candidate = `${baseName} ${number}`
    while (reserved.has(candidate)) {
        candidate = `${baseName} ${++number}`
    }
    return candidate
}

export function clonePersonaToStore(
    source: RisuPersona,
    target: RisuPersona[],
    createId: () => string,
): RisuPersona {
    const clone = safeStructuredClone(source)
    clone.name = nextPersonaCopyName(source.name, target.map((persona) => persona.name))
    clone.id = createId()
    target.push(clone)
    return clone
}
