export type CanonicalReceiptDocumentType = 'character' | 'location' | 'scene'
    | 'faction' | 'item' | 'concept' | 'other'

export interface CanonicalTurnReceiptChange {
    documentId: string
    type: CanonicalReceiptDocumentType
    title: string
    relativePath: string
    action: 'create' | 'update'
    afterHash: string
}

export interface CanonicalTurnReceipt {
    sourceMessageIds: string[]
    eventIds: string[]
    changes: CanonicalTurnReceiptChange[]
    warnings: string[]
    recordedAt: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const documentTypes: readonly CanonicalReceiptDocumentType[] = [
    'character', 'location', 'scene', 'faction', 'item', 'concept', 'other',
]

export function parseCanonicalTurnReceipt(
    value: unknown
): CanonicalTurnReceipt {
    if (!isRecord(value)
        || Object.keys(value).length !== 5
        || !['sourceMessageIds', 'eventIds', 'changes', 'warnings',
            'recordedAt'].every((key) => Object.hasOwn(value, key))
        || !Array.isArray(value.sourceMessageIds)
        || !value.sourceMessageIds.every((id) => typeof id === 'string')
        || !Array.isArray(value.eventIds)
        || !value.eventIds.every((id) => typeof id === 'string')
        || !Array.isArray(value.warnings)
        || !value.warnings.every((warning) => typeof warning === 'string')
        || typeof value.recordedAt !== 'string'
        || !Array.isArray(value.changes)) {
        throw new Error('Invalid wiki turn receipt')
    }
    const changes = value.changes.map((change) => {
        if (!isRecord(change)
            || Object.keys(change).length !== 6
            || !['documentId', 'type', 'title', 'relativePath', 'action',
                'afterHash'].every((key) => Object.hasOwn(change, key))
            || typeof change.documentId !== 'string'
            || !documentTypes.includes(
                change.type as CanonicalReceiptDocumentType
            )
            || typeof change.title !== 'string'
            || typeof change.relativePath !== 'string'
            || (change.action !== 'create' && change.action !== 'update')
            || typeof change.afterHash !== 'string') {
            throw new Error('Invalid wiki turn receipt change')
        }
        return change as unknown as CanonicalTurnReceiptChange
    })
    return {
        sourceMessageIds: [...value.sourceMessageIds] as string[],
        eventIds: [...value.eventIds] as string[],
        changes,
        warnings: [...value.warnings] as string[],
        recordedAt: value.recordedAt,
    }
}
