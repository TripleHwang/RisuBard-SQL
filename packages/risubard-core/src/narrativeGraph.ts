import type {
    EvidenceRef,
    NarrativeMemoryState,
} from './memoryDelta'

export type NarrativeNodeKind =
    | 'entity'
    | 'event'
    | 'state'
    | 'claim'
    | 'thread'

export type NarrativeNodeSubtype =
    | 'character'
    | 'event'
    | 'relationship'
    | 'fact'
    | 'belief'
    | 'promise'
    | 'goal'

export type NarrativeNodeStatus =
    | 'active'
    | 'resolved'
    | 'invalidated'
    | 'superseded'

export type NarrativeEdgeType =
    | 'involves'
    | 'about'
    | 'changed'
    | 'believed_by'
    | 'supersedes'

export type NarrativePerspective =
    | { kind: 'omniscient' }
    | { kind: 'character', entityId: string }

export interface NarrativeNode {
    id: string
    kind: NarrativeNodeKind
    subtype: NarrativeNodeSubtype
    title: string
    summary: string
    storyId: string
    branchId: string
    status: NarrativeNodeStatus
    authority: 'draft' | 'canonical'
    salience: number
    perspective: NarrativePerspective
    epistemic: 'fact' | 'belief'
    evidence: EvidenceRef[]
    statusEvidence?: EvidenceRef[]
    revision: number
    occurredAt?: number
    validFrom?: number
    validUntil?: number
}

export interface NarrativeEdge {
    id: string
    sourceId: string
    type: NarrativeEdgeType
    targetId: string
    storyId: string
    branchId: string
    evidence: EvidenceRef[]
    revision: number
}

export interface NarrativeGraphStateV2 {
    schemaVersion: 2
    storyId: string
    branchId: string
    revision: number
    nodes: NarrativeNode[]
    edges: NarrativeEdge[]
    appliedOperationIds: string[]
    appliedOperationBindings?: NarrativeOperationBinding[]
}

export interface NarrativeOperationBinding {
    operationId: string
    type: 'add-node' | 'update-node-status' | 'add-edge'
    targetId: string
}

const nodeKeys = [
    'id',
    'kind',
    'subtype',
    'title',
    'summary',
    'storyId',
    'branchId',
    'status',
    'authority',
    'salience',
    'perspective',
    'epistemic',
    'evidence',
    'statusEvidence',
    'revision',
    'occurredAt',
    'validFrom',
    'validUntil',
] as const

const edgeKeys = [
    'id',
    'sourceId',
    'type',
    'targetId',
    'storyId',
    'branchId',
    'evidence',
    'revision',
] as const

const subtypesByKind: Record<NarrativeNodeKind, NarrativeNodeSubtype[]> = {
    entity: ['character'],
    event: ['event'],
    state: ['relationship'],
    claim: ['fact', 'belief'],
    thread: ['promise', 'goal'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertNoExtraKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    label: string
): void {
    const allowed = new Set(keys)
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error(`Unexpected ${label} field: ${key}`)
        }
    }
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function requireInteger(
    value: unknown,
    label: string,
    minimum = 0
): number {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new Error(`${label} must be an integer of at least ${minimum}`)
    }
    return value as number
}

function parseEvidence(value: unknown): EvidenceRef[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error('Narrative node must include evidence')
    }
    return value.map((item) => {
        if (!isRecord(item)) throw new Error('Narrative evidence is invalid')
        assertNoExtraKeys(item, ['chatId', 'messageId'], 'evidence')
        return {
            chatId: requireString(item.chatId, 'Evidence chatId'),
            messageId: requireString(item.messageId, 'Evidence messageId'),
        }
    })
}

function parsePerspective(value: unknown): NarrativePerspective {
    if (!isRecord(value)) throw new Error('Narrative perspective is invalid')
    if (value.kind === 'omniscient') {
        assertNoExtraKeys(value, ['kind'], 'narrative perspective')
        return { kind: 'omniscient' }
    }
    if (value.kind === 'character') {
        assertNoExtraKeys(
            value,
            ['kind', 'entityId'],
            'narrative perspective'
        )
        return {
            kind: 'character',
            entityId: requireString(
                value.entityId,
                'Perspective entity ID'
            ),
        }
    }
    throw new Error('Unsupported narrative perspective')
}

function optionalInteger(value: unknown, label: string): number | undefined {
    return value === undefined ? undefined : requireInteger(value, label)
}

function parseNode(
    value: unknown,
    storyId: string,
    branchId: string
): NarrativeNode {
    if (!isRecord(value)) throw new Error('Narrative node must be an object')
    assertNoExtraKeys(value, nodeKeys, 'narrative node')
    const kind = value.kind
    if (!Object.hasOwn(subtypesByKind, String(kind))) {
        throw new Error(`Unsupported narrative node kind: ${String(kind)}`)
    }
    const typedKind = kind as NarrativeNodeKind
    if (!subtypesByKind[typedKind].includes(
        value.subtype as NarrativeNodeSubtype
    )) {
        throw new Error(
            `Unsupported ${typedKind} subtype: ${String(value.subtype)}`
        )
    }
    const status = value.status
    if (!['active', 'resolved', 'invalidated', 'superseded'].includes(
        String(status)
    )) {
        throw new Error('Unsupported narrative node status')
    }
    if (value.authority !== 'draft' && value.authority !== 'canonical') {
        throw new Error('Unsupported narrative node authority')
    }
    if (value.epistemic !== 'fact' && value.epistemic !== 'belief') {
        throw new Error('Unsupported narrative epistemic status')
    }
    const perspective = parsePerspective(value.perspective)
    if (value.subtype === 'belief' && perspective.kind !== 'character') {
        throw new Error('Belief claims require a character perspective')
    }
    if (value.subtype === 'belief' && value.epistemic !== 'belief') {
        throw new Error('Belief claims require belief epistemic status')
    }
    if (value.subtype === 'fact'
        && (perspective.kind !== 'omniscient'
            || value.epistemic !== 'fact')) {
        throw new Error('Fact claims require omniscient fact semantics')
    }
    if (value.storyId !== storyId || value.branchId !== branchId) {
        throw new Error('Narrative node is outside graph scope')
    }
    const node: NarrativeNode = {
        id: requireString(value.id, 'Narrative node ID'),
        kind: typedKind,
        subtype: value.subtype as NarrativeNodeSubtype,
        title: requireString(value.title, 'Narrative node title'),
        summary: requireString(value.summary, 'Narrative node summary'),
        storyId,
        branchId,
        status: status as NarrativeNodeStatus,
        authority: value.authority,
        salience: requireInteger(value.salience, 'Narrative salience'),
        perspective,
        epistemic: value.epistemic,
        evidence: parseEvidence(value.evidence),
        revision: requireInteger(value.revision, 'Narrative node revision'),
    }
    if (value.statusEvidence !== undefined) {
        node.statusEvidence = parseEvidence(value.statusEvidence)
    }
    const occurredAt = optionalInteger(value.occurredAt, 'occurredAt')
    const validFrom = optionalInteger(value.validFrom, 'validFrom')
    const validUntil = optionalInteger(value.validUntil, 'validUntil')
    if (occurredAt !== undefined) node.occurredAt = occurredAt
    if (validFrom !== undefined) node.validFrom = validFrom
    if (validUntil !== undefined) node.validUntil = validUntil
    if (validFrom !== undefined
        && validUntil !== undefined
        && validUntil < validFrom) {
        throw new Error('Narrative validity interval is reversed')
    }
    return node
}

function parseEdge(
    value: unknown,
    storyId: string,
    branchId: string
): NarrativeEdge {
    if (!isRecord(value)) throw new Error('Narrative edge must be an object')
    assertNoExtraKeys(value, edgeKeys, 'narrative edge')
    if (![
        'involves',
        'about',
        'changed',
        'believed_by',
        'supersedes',
    ].includes(String(value.type))) {
        throw new Error(`Unsupported narrative edge type: ${String(value.type)}`)
    }
    if (value.storyId !== storyId || value.branchId !== branchId) {
        throw new Error('Narrative edge is outside graph scope')
    }
    return {
        id: requireString(value.id, 'Narrative edge ID'),
        sourceId: requireString(value.sourceId, 'Narrative edge source ID'),
        type: value.type as NarrativeEdgeType,
        targetId: requireString(value.targetId, 'Narrative edge target ID'),
        storyId,
        branchId,
        evidence: parseEvidence(value.evidence),
        revision: requireInteger(value.revision, 'Narrative edge revision'),
    }
}

function requireUnique(values: readonly string[], label: string): void {
    if (new Set(values).size !== values.length) {
        throw new Error(`Duplicate ${label}`)
    }
}

export function validateNarrativeGraphState(
    value: unknown
): NarrativeGraphStateV2 {
    if (!isRecord(value) || value.schemaVersion !== 2) {
        throw new Error('Unsupported narrative graph schema version')
    }
    assertNoExtraKeys(value, [
        'schemaVersion',
        'storyId',
        'branchId',
        'revision',
        'nodes',
        'edges',
        'appliedOperationIds',
        'appliedOperationBindings',
    ], 'narrative graph')
    const storyId = requireString(value.storyId, 'Story ID')
    const branchId = requireString(value.branchId, 'Branch ID')
    if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)
        || !Array.isArray(value.appliedOperationIds)) {
        throw new Error('Narrative graph collections must be arrays')
    }
    const nodes = value.nodes.map((node) =>
        parseNode(node, storyId, branchId)
    )
    const nodeIds = nodes.map((node) => node.id)
    requireUnique(nodeIds, 'narrative node ID')
    const nodeIdSet = new Set(nodeIds)
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    for (const node of nodes) {
        if (node.perspective.kind === 'character') {
            const character = nodeById.get(node.perspective.entityId)
            if (character?.kind !== 'entity'
                || character.subtype !== 'character') {
                throw new Error(
                    `Perspective character does not exist: ${node.id}`
                )
            }
        }
    }
    const edges = value.edges.map((edge) =>
        parseEdge(edge, storyId, branchId)
    )
    requireUnique(edges.map((edge) => edge.id), 'narrative edge ID')
    for (const edge of edges) {
        if (!nodeIdSet.has(edge.sourceId)) {
            throw new Error(`Narrative edge source does not exist: ${edge.id}`)
        }
        if (!nodeIdSet.has(edge.targetId)) {
            throw new Error(`Narrative edge target does not exist: ${edge.id}`)
        }
        const source = nodeById.get(edge.sourceId)!
        const target = nodeById.get(edge.targetId)!
        if (edge.type === 'involves'
            && (!(source.kind === 'event' || source.kind === 'thread')
                || target.kind !== 'entity')) {
            throw new Error(
                'involves must connect an event or thread to an entity'
            )
        }
        if (edge.type === 'about'
            && (!(
                source.kind === 'claim'
                || source.kind === 'thread'
                || source.kind === 'state'
            ) || target.kind !== 'entity')) {
            throw new Error(
                'about must connect a claim, thread or state to an entity'
            )
        }
        if (edge.type === 'changed'
            && (!(source.kind === 'event' || source.kind === 'claim')
                || target.kind !== 'state')) {
            throw new Error(
                'changed must connect an event or claim to a state'
            )
        }
        if (edge.type === 'believed_by'
            && (source.kind !== 'claim'
                || source.subtype !== 'belief'
                || target.kind !== 'entity'
                || target.subtype !== 'character')) {
            throw new Error(
                'believed_by must connect a claim to a character'
            )
        }
        if (edge.type === 'believed_by'
            && (source.perspective.kind !== 'character'
                || source.perspective.entityId !== target.id)) {
            throw new Error(
                'believed_by holder must match claim perspective'
            )
        }
        if (edge.type === 'supersedes'
            && (source.kind !== target.kind
                || !['state', 'claim', 'thread'].includes(source.kind))) {
            throw new Error(
                'supersedes must connect compatible mutable nodes'
            )
        }
    }
    const appliedOperationIds = value.appliedOperationIds.map((id) =>
        requireString(id, 'Applied operation ID')
    )
    requireUnique(appliedOperationIds, 'applied operation ID')
    const rawOperationBindings = value.appliedOperationBindings
    if (rawOperationBindings !== undefined
        && !Array.isArray(rawOperationBindings)) {
        throw new Error('Applied operation bindings must be an array')
    }
    const operationBindings = rawOperationBindings === undefined
        ? []
        : rawOperationBindings as unknown[]
    const appliedOperationBindings = operationBindings.map((binding) => {
        if (typeof binding !== 'object' || binding === null
            || Array.isArray(binding)) {
            throw new Error('Applied operation binding must be an object')
        }
        const bindingRecord = binding as Record<string, unknown>
        assertNoExtraKeys(bindingRecord, [
            'operationId',
            'type',
            'targetId',
        ], 'applied operation binding')
        const type = bindingRecord.type
        if (!['add-node', 'update-node-status', 'add-edge'].includes(
            String(type)
        )) {
            throw new Error('Unsupported applied operation binding type')
        }
        return {
            operationId: requireString(
                bindingRecord.operationId,
                'Applied operation binding ID'
            ),
            type: type as NarrativeOperationBinding['type'],
            targetId: requireString(
                bindingRecord.targetId,
                'Applied operation binding target ID'
            ),
        }
    })
    requireUnique(
        appliedOperationBindings.map((binding) => binding.operationId),
        'applied operation binding ID'
    )
    const appliedOperationIdSet = new Set(appliedOperationIds)
    if (appliedOperationBindings.some(
        (binding) => !appliedOperationIdSet.has(binding.operationId)
    )) {
        throw new Error('Applied operation binding has unknown operation ID')
    }
    return {
        schemaVersion: 2,
        storyId,
        branchId,
        revision: requireInteger(value.revision, 'Graph revision'),
        nodes,
        edges,
        appliedOperationIds,
        ...(value.appliedOperationBindings === undefined
            ? {}
            : { appliedOperationBindings }),
    }
}

export function adaptV1NarrativeMemory(input: {
    state: NarrativeMemoryState
    storyId: string
    branchId: string
}): NarrativeGraphStateV2 {
    const storyId = requireString(input.storyId, 'Story ID')
    const branchId = requireString(input.branchId, 'Branch ID')
    const common = {
        storyId,
        branchId,
        authority: 'draft' as const,
        salience: 5,
        perspective: { kind: 'omniscient' as const },
        epistemic: 'fact' as const,
        revision: 1,
    }
    const nodes: NarrativeNode[] = [
        ...input.state.facts.map((fact) => ({
            ...common,
            id: `claim:v1:${fact.id}`,
            kind: 'claim' as const,
            subtype: 'fact' as const,
            title: fact.text.slice(0, 80),
            summary: fact.text,
            status: fact.status,
            evidence: fact.evidence.map((item) => ({ ...item })),
        })),
        ...input.state.events.map((event, index) => ({
            ...common,
            id: `event:v1:${event.id}`,
            kind: 'event' as const,
            subtype: 'event' as const,
            title: event.summary.slice(0, 80),
            summary: event.summary,
            status: 'active' as const,
            evidence: event.evidence.map((item) => ({ ...item })),
            occurredAt: index + 1,
        })),
    ]
    return validateNarrativeGraphState({
        schemaVersion: 2,
        storyId,
        branchId,
        revision: input.state.appliedOperationIds.length,
        nodes,
        edges: [],
        appliedOperationIds: [...input.state.appliedOperationIds],
    })
}
