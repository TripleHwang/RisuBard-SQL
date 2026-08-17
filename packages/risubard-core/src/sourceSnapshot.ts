export type NarrativeSourceKind =
    | 'character-description'
    | 'lorebook-entry'

export interface NarrativeSourceInput {
    sourceId: string
    kind: NarrativeSourceKind
    content: string
}

export interface NarrativeSourceRecord extends NarrativeSourceInput {
    fingerprint: string
}

export interface NarrativeSourceSnapshot {
    schemaVersion: 1
    sources: NarrativeSourceRecord[]
}

export interface NarrativeSourceDiff {
    added: string[]
    updated: string[]
    deleted: string[]
    unchanged: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    label: string
): void {
    const expected = new Set(keys)
    for (const key of Object.keys(value)) {
        if (!expected.has(key)) {
            throw new Error(`Unexpected ${label} field: ${key}`)
        }
    }
    for (const key of keys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new Error(`Missing ${label} field: ${key}`)
        }
    }
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function requireKind(value: unknown): NarrativeSourceKind {
    if (value !== 'character-description' && value !== 'lorebook-entry') {
        throw new Error(`Unsupported narrative source kind: ${String(value)}`)
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

function fingerprint(kind: NarrativeSourceKind, content: string): string {
    const bytes = new TextEncoder().encode(JSON.stringify([kind, content]))
    let hash = 0xcbf29ce484222325n
    for (const byte of bytes) {
        hash ^= BigInt(byte)
        hash = BigInt.asUintN(64, hash * 0x100000001b3n)
    }
    return hash.toString(16).padStart(16, '0')
}

function parseInput(value: unknown): NarrativeSourceInput {
    if (!isRecord(value)) {
        throw new Error('Narrative source must be an object')
    }
    assertExactKeys(
        value,
        ['sourceId', 'kind', 'content'],
        'narrative source'
    )
    return {
        sourceId: requireString(value.sourceId, 'Narrative source ID'),
        kind: requireKind(value.kind),
        content: requireString(value.content, 'Narrative source content'),
    }
}

function sortBySourceId<T extends { sourceId: string }>(
    values: T[]
): T[] {
    return values.sort((left, right) => {
        if (left.sourceId < right.sourceId) return -1
        if (left.sourceId > right.sourceId) return 1
        return 0
    })
}

export function createNarrativeSourceSnapshot(
    value: unknown
): NarrativeSourceSnapshot {
    const inputs = requireDenseArray(value, 'Narrative sources')
    const sourceIds = new Set<string>()
    const sources = inputs.map((item) => {
        const source = parseInput(item)
        if (sourceIds.has(source.sourceId)) {
            throw new Error(`Duplicate narrative source ID: ${source.sourceId}`)
        }
        sourceIds.add(source.sourceId)
        return {
            ...source,
            fingerprint: fingerprint(source.kind, source.content),
        }
    })
    return {
        schemaVersion: 1,
        sources: sortBySourceId(sources),
    }
}

export function validateNarrativeSourceSnapshot(
    value: unknown
): NarrativeSourceSnapshot {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error('Unsupported narrative source snapshot version')
    }
    assertExactKeys(
        value,
        ['schemaVersion', 'sources'],
        'narrative source snapshot'
    )
    const storedSources = requireDenseArray(
        value.sources,
        'Narrative source snapshot sources'
    )
    const inputs = storedSources.map((item) => {
        if (!isRecord(item)) {
            throw new Error('Stored narrative source must be an object')
        }
        assertExactKeys(
            item,
            ['sourceId', 'kind', 'content', 'fingerprint'],
            'stored narrative source'
        )
        const input = parseInput({
            sourceId: item.sourceId,
            kind: item.kind,
            content: item.content,
        })
        const expectedFingerprint = fingerprint(input.kind, input.content)
        if (item.fingerprint !== expectedFingerprint) {
            throw new Error(
                `Invalid narrative source fingerprint: ${input.sourceId}`
            )
        }
        return input
    })
    return createNarrativeSourceSnapshot(inputs)
}

export function diffNarrativeSourceSnapshots(
    previousValue: unknown,
    nextValue: unknown
): NarrativeSourceDiff {
    const previous = validateNarrativeSourceSnapshot(previousValue)
    const next = validateNarrativeSourceSnapshot(nextValue)
    const previousById = new Map(
        previous.sources.map((source) => [source.sourceId, source])
    )
    const nextById = new Map(
        next.sources.map((source) => [source.sourceId, source])
    )
    const added: string[] = []
    const updated: string[] = []
    const deleted: string[] = []
    const unchanged: string[] = []

    for (const source of next.sources) {
        const oldSource = previousById.get(source.sourceId)
        if (!oldSource) added.push(source.sourceId)
        else if (oldSource.fingerprint !== source.fingerprint) {
            updated.push(source.sourceId)
        }
        else unchanged.push(source.sourceId)
    }
    for (const source of previous.sources) {
        if (!nextById.has(source.sourceId)) deleted.push(source.sourceId)
    }

    return { added, updated, deleted, unchanged }
}
