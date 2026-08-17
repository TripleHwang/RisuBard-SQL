import {
    createNarrativeSourceSnapshot,
    type NarrativeSourceInput,
    type NarrativeSourceSnapshot,
} from '../../../packages/risubard-core/src/sourceSnapshot'

interface LegacyLoreEntry {
    id?: unknown
    key?: unknown
    secondkey?: unknown
    comment?: unknown
    content?: unknown
    mode?: unknown
}

interface LegacyLoreGroup {
    scopeId: string
    entries: readonly LegacyLoreEntry[]
}

export interface LegacyNarrativeSourceProjectionInput {
    characterId: string
    description?: string | null
    loreGroups: readonly LegacyLoreGroup[]
}

export interface ActiveLoreSource {
    sourceIdentity: {
        scopeId: string
        entry: LegacyLoreEntry
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function requireDenseArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new Error(`${label} must be a dense array`)
        }
    }
    return value
}

function optionalString(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function encoded(value: string): string {
    return encodeURIComponent(value)
}

function legacyIdentityFingerprint(
    scopeId: string,
    entry: LegacyLoreEntry,
    content: string
): string {
    const identity = JSON.stringify([
        scopeId,
        optionalString(entry.key),
        optionalString(entry.secondkey),
        optionalString(entry.comment),
        optionalString(entry.mode),
        content,
    ])
    return createNarrativeSourceSnapshot([{
        sourceId: 'legacy-identity',
        kind: 'lorebook-entry',
        content: identity,
    }]).sources[0].fingerprint
}

export function projectLegacyNarrativeSources(
    value: LegacyNarrativeSourceProjectionInput
): NarrativeSourceSnapshot {
    if (!isRecord(value)) {
        throw new Error('Legacy narrative source input must be an object')
    }
    const characterId = requireNonEmptyString(
        value.characterId,
        'Character ID'
    )
    const loreGroups = requireDenseArray(value.loreGroups, 'Lore groups')
    const sources: NarrativeSourceInput[] = []
    if (typeof value.description === 'string'
        && value.description.trim().length > 0) {
        sources.push({
            sourceId: `character-description:${encoded(characterId)}`,
            kind: 'character-description',
            content: value.description,
        })
    }

    const legacyOccurrences = new Map<string, number>()
    for (const rawGroup of loreGroups) {
        if (!isRecord(rawGroup)) throw new Error('Lore group must be an object')
        const scopeId = requireNonEmptyString(
            rawGroup.scopeId,
            'Lore scope ID'
        )
        const entries = requireDenseArray(
            rawGroup.entries,
            'Lore group entries'
        )
        for (const rawEntry of entries) {
            if (!isRecord(rawEntry)) {
                throw new Error('Lore entry must be an object')
            }
            if (rawEntry.mode === 'folder') continue
            const content = optionalString(rawEntry.content)
            if (content.trim().length === 0) continue

            const explicitId = optionalString(rawEntry.id)
            let sourceId: string
            if (explicitId.trim().length > 0) {
                sourceId = [
                    'lorebook',
                    encoded(scopeId),
                    'id',
                    encoded(explicitId),
                ].join(':')
            }
            else {
                const identity = legacyIdentityFingerprint(
                    scopeId,
                    rawEntry,
                    content
                )
                const baseId = [
                    'lorebook',
                    encoded(scopeId),
                    'legacy',
                    identity,
                ].join(':')
                const occurrence = legacyOccurrences.get(baseId) ?? 0
                legacyOccurrences.set(baseId, occurrence + 1)
                sourceId = `${baseId}:${occurrence}`
            }
            sources.push({
                sourceId,
                kind: 'lorebook-entry',
                content,
            })
        }
    }

    return createNarrativeSourceSnapshot(sources)
}

export function projectActiveNarrativeSources(input: {
    characterId: string
    description: string
    actives: readonly ActiveLoreSource[]
}): NarrativeSourceSnapshot {
    const groups = new Map<string, LegacyLoreEntry[]>()
    for (const active of input.actives) {
        const scopeId = active.sourceIdentity.scopeId
        const entries = groups.get(scopeId) ?? []
        entries.push(active.sourceIdentity.entry)
        groups.set(scopeId, entries)
    }
    return projectLegacyNarrativeSources({
        characterId: input.characterId,
        description: input.description,
        loreGroups: [...groups].map(([scopeId, entries]) => ({
            scopeId,
            entries,
        })),
    })
}
