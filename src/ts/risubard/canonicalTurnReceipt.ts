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

const CANONICAL_UPDATE_RETRY_PREFIX = '정본 문서 갱신 실패'

function canonicalFailureCategory(error: unknown): string {
    const message = (error instanceof Error ? error.message : String(error))
        .toLocaleLowerCase()
    if (/timed?\s*out|timeout|시간.*초과/u.test(message)) return '타임아웃'
    if (/\b429\b|rate.?limit|resource exhausted|quota/u.test(message)) {
        return '호출 제한'
    }
    if (/\b(?:401|403)\b|unauthor|forbidden|authentication|api.?key/u.test(message)) {
        return '인증 오류'
    }
    if (/\b5\d\d\b|bad gateway|service unavailable|internal server/u.test(message)) {
        return '공급자 서버 오류'
    }
    if (/network|fetch|econn|enotfound|socket|connection|proxy/u.test(message)) {
        return '네트워크 오류'
    }
    return '공급자 응답 오류'
}

export function formatCanonicalUpdateFailureWarning(error: unknown): string {
    return `${CANONICAL_UPDATE_RETRY_PREFIX} (${canonicalFailureCategory(error)}). `
        + '사건 기록은 보존했지만 정보 문서는 저장하지 않았습니다. '
        + '다음 턴에 자동으로 다시 시도합니다.'
}

export function canonicalTurnNeedsRetry(
    receipt: CanonicalTurnReceipt
): boolean {
    return receipt.warnings.some((warning) =>
        warning.startsWith(CANONICAL_UPDATE_RETRY_PREFIX)
    )
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
