export interface EvidenceRef {
    chatId: string
    messageId: string
}

export interface AddFactOperation {
    type: 'add-fact'
    operationId: string
    factId: string
    text: string
    evidence: EvidenceRef[]
}

export interface AppendEventOperation {
    type: 'append-event'
    operationId: string
    eventId: string
    summary: string
    evidence: EvidenceRef[]
}

export interface InvalidateFactOperation {
    type: 'invalidate-fact'
    operationId: string
    factId: string
    evidence: EvidenceRef[]
}

export type MemoryOperation =
    | AddFactOperation
    | AppendEventOperation
    | InvalidateFactOperation

export interface MemoryDelta {
    schemaVersion: 1
    operations: MemoryOperation[]
}

export interface NarrativeFact {
    id: string
    text: string
    status: 'active' | 'invalidated'
    evidence: EvidenceRef[]
    invalidatedBy?: EvidenceRef[]
}

export interface NarrativeEvent {
    id: string
    summary: string
    evidence: EvidenceRef[]
}

export interface NarrativeMemoryState {
    facts: NarrativeFact[]
    events: NarrativeEvent[]
    appliedOperationIds: string[]
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

function assertExactKeys(
    value: Record<string, unknown>,
    allowedKeys: readonly string[],
    label: string
): void {
    const allowed = new Set(allowedKeys)
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error(`Unexpected ${label} field: ${key}`)
        }
    }
}

export function validateMemoryDelta(
    value: unknown,
    state: NarrativeMemoryState,
    availableEvidence: readonly EvidenceRef[]
): MemoryDelta {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error('Unsupported MemoryDelta schema version')
    }
    assertExactKeys(value, ['schemaVersion', 'operations'], 'MemoryDelta')
    if (!Array.isArray(value.operations)) {
        throw new Error('MemoryDelta operations must be an array')
    }

    const evidenceByChat = new Map<string, Set<string>>()
    for (const evidence of availableEvidence) {
        let messageIds = evidenceByChat.get(evidence.chatId)
        if (!messageIds) {
            messageIds = new Set()
            evidenceByChat.set(evidence.chatId, messageIds)
        }
        messageIds.add(evidence.messageId)
    }
    const operationIds = new Set<string>()
    const appliedOperationIds = new Set(state.appliedOperationIds)
    const factStatuses = new Map<string, NarrativeFact['status']>(
        state.facts.map((fact) => [fact.id, fact.status])
    )
    const eventIds = new Set(state.events.map((event) => event.id))
    const operations: MemoryOperation[] = []

    for (const rawOperation of value.operations) {
        if (!isRecord(rawOperation)) {
            throw new Error('MemoryDelta operation must be an object')
        }
        const type = rawOperation.type
        switch (type) {
            case 'add-fact':
                assertExactKeys(
                    rawOperation,
                    ['type', 'operationId', 'factId', 'text', 'evidence'],
                    type
                )
                break
            case 'invalidate-fact':
                assertExactKeys(
                    rawOperation,
                    ['type', 'operationId', 'factId', 'evidence'],
                    type
                )
                break
            case 'append-event':
                assertExactKeys(
                    rawOperation,
                    ['type', 'operationId', 'eventId', 'summary', 'evidence'],
                    type
                )
                break
            default:
                throw new Error(
                    `Unsupported MemoryDelta operation: ${String(type)}`
                )
        }

        const operationId = requireNonEmptyString(
            rawOperation.operationId,
            'Operation ID'
        )
        if (operationIds.has(operationId)) {
            throw new Error(`Duplicate operation ID: ${operationId}`)
        }
        operationIds.add(operationId)

        if (!Array.isArray(rawOperation.evidence)
            || rawOperation.evidence.length === 0) {
            throw new Error(`Operation ${operationId} must include evidence`)
        }
        const evidence = rawOperation.evidence.map((rawEvidence) => {
            if (!isRecord(rawEvidence)) {
                throw new Error(`Operation ${operationId} has invalid evidence`)
            }
            assertExactKeys(
                rawEvidence,
                ['chatId', 'messageId'],
                'evidence'
            )
            return {
                chatId: requireNonEmptyString(
                    rawEvidence.chatId,
                    'Evidence chatId'
                ),
                messageId: requireNonEmptyString(
                    rawEvidence.messageId,
                    'Evidence messageId'
                ),
            }
        })

        const alreadyApplied = appliedOperationIds.has(operationId)
        for (const reference of evidence) {
            if (!evidenceByChat.get(reference.chatId)?.has(reference.messageId)) {
                throw new Error(
                    `Unknown evidence reference: ${reference.chatId}/${reference.messageId}`
                )
            }
        }

        switch (type) {
            case 'add-fact': {
                const factId = requireNonEmptyString(
                    rawOperation.factId,
                    'Fact ID'
                )
                const text = requireNonEmptyString(
                    rawOperation.text,
                    'Fact text'
                )
                if (!alreadyApplied) {
                    if (factStatuses.has(factId)) {
                        throw new Error(`Fact already exists: ${factId}`)
                    }
                    factStatuses.set(factId, 'active')
                }
                operations.push({
                    type,
                    operationId,
                    factId,
                    text,
                    evidence,
                })
                break
            }
            case 'invalidate-fact': {
                const factId = requireNonEmptyString(
                    rawOperation.factId,
                    'Fact ID'
                )
                if (!alreadyApplied) {
                    if (factStatuses.get(factId) !== 'active') {
                        throw new Error(
                            `Cannot invalidate unknown or inactive fact: ${factId}`
                        )
                    }
                    factStatuses.set(factId, 'invalidated')
                }
                operations.push({
                    type,
                    operationId,
                    factId,
                    evidence,
                })
                break
            }
            case 'append-event': {
                const eventId = requireNonEmptyString(
                    rawOperation.eventId,
                    'Event ID'
                )
                const summary = requireNonEmptyString(
                    rawOperation.summary,
                    'Event summary'
                )
                if (!alreadyApplied) {
                    if (eventIds.has(eventId)) {
                        throw new Error(`Event already exists: ${eventId}`)
                    }
                    eventIds.add(eventId)
                }
                operations.push({
                    type,
                    operationId,
                    eventId,
                    summary,
                    evidence,
                })
                break
            }
        }
    }

    return {
        schemaVersion: 1,
        operations,
    }
}

export function applyMemoryDelta(
    state: NarrativeMemoryState,
    delta: unknown,
    availableEvidence: readonly EvidenceRef[]
): NarrativeMemoryState {
    const parsedDelta = validateMemoryDelta(delta, state, availableEvidence)

    const facts = state.facts.map((fact) => {
        const cloned: NarrativeFact = {
            ...fact,
            evidence: fact.evidence.map((evidence) => ({ ...evidence })),
        }
        if (fact.invalidatedBy) {
            cloned.invalidatedBy = fact.invalidatedBy.map(
                (evidence) => ({ ...evidence })
            )
        }
        return cloned
    })
    const events = state.events.map((event) => ({
        ...event,
        evidence: event.evidence.map((evidence) => ({ ...evidence })),
    }))
    const appliedOperationIds = [...state.appliedOperationIds]
    const appliedOperationIdSet = new Set(appliedOperationIds)

    for (const operation of parsedDelta.operations) {
        if (appliedOperationIdSet.has(operation.operationId)) {
            continue
        }

        if (operation.type === 'add-fact') {
            facts.push({
                id: operation.factId,
                text: operation.text,
                status: 'active',
                evidence: operation.evidence.map((evidence) => ({ ...evidence })),
            })
        }
        else if (operation.type === 'append-event') {
            events.push({
                id: operation.eventId,
                summary: operation.summary,
                evidence: operation.evidence.map((evidence) => ({ ...evidence })),
            })
        }
        else {
            const fact = facts.find((candidate) =>
                candidate.id === operation.factId
            )
            if (!fact) throw new Error('Validated fact was not found')
            fact.status = 'invalidated'
            fact.invalidatedBy = operation.evidence.map(
                (evidence) => ({ ...evidence })
            )
        }
        appliedOperationIds.push(operation.operationId)
        appliedOperationIdSet.add(operation.operationId)
    }

    return {
        facts,
        events,
        appliedOperationIds,
    }
}
