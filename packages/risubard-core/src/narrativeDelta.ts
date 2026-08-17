import type {
    EvidenceRef,
    MemoryDelta,
    NarrativeMemoryState,
} from './memoryDelta'
import {
    validateNarrativeGraphState,
    type NarrativeEdge,
    type NarrativeGraphStateV2,
    type NarrativeNode,
    type NarrativeNodeStatus,
} from './narrativeGraph'

export interface AddNarrativeNodeOperation {
    type: 'add-node'
    operationId: string
    node: Omit<NarrativeNode, 'revision' | 'statusEvidence'>
}

export interface UpdateNarrativeNodeStatusOperation {
    type: 'update-node-status'
    operationId: string
    nodeId: string
    status: Exclude<NarrativeNodeStatus, 'active'>
    evidence: EvidenceRef[]
}

export interface AddNarrativeEdgeOperation {
    type: 'add-edge'
    operationId: string
    edge: Omit<NarrativeEdge, 'revision'>
}

export type NarrativeGraphOperation =
    | AddNarrativeNodeOperation
    | UpdateNarrativeNodeStatusOperation
    | AddNarrativeEdgeOperation

export interface NarrativeGraphDeltaV2 {
    schemaVersion: 2
    storyId: string
    branchId: string
    operations: NarrativeGraphOperation[]
}

export function projectMemoryDeltaToNarrativeGraphDelta(
    delta: MemoryDelta,
    storyId: string,
    branchId: string
): NarrativeGraphDeltaV2 {
    const scopedStoryId = requireString(storyId, 'Story ID')
    const scopedBranchId = requireString(branchId, 'Branch ID')
    return {
        schemaVersion: 2,
        storyId: scopedStoryId,
        branchId: scopedBranchId,
        operations: delta.operations.map((operation) => {
            const evidence = operation.evidence.map((item) => ({ ...item }))
            if (operation.type === 'invalidate-fact') {
                return {
                    type: 'update-node-status',
                    operationId: operation.operationId,
                    nodeId: `claim:v1:${operation.factId}`,
                    status: 'invalidated',
                    evidence,
                }
            }
            const summary = operation.type === 'add-fact'
                ? operation.text
                : operation.summary
            return {
                type: 'add-node',
                operationId: operation.operationId,
                node: {
                    id: operation.type === 'add-fact'
                        ? `claim:v1:${operation.factId}`
                        : `event:v1:${operation.eventId}`,
                    kind: operation.type === 'add-fact'
                        ? 'claim'
                        : 'event',
                    subtype: operation.type === 'add-fact'
                        ? 'fact'
                        : 'event',
                    title: summary.slice(0, 80),
                    summary,
                    storyId: scopedStoryId,
                    branchId: scopedBranchId,
                    status: 'active',
                    authority: 'draft',
                    salience: 5,
                    perspective: { kind: 'omniscient' },
                    epistemic: 'fact',
                    evidence,
                },
            }
        }),
    }
}

function sameProjectedNodeContent(
    current: NarrativeNode,
    proposed: Omit<NarrativeNode, 'revision' | 'statusEvidence'>
): boolean {
    return current.id === proposed.id
        && current.kind === proposed.kind
        && current.subtype === proposed.subtype
        && current.title === proposed.title
        && current.summary === proposed.summary
        && current.storyId === proposed.storyId
        && current.branchId === proposed.branchId
        && current.authority === proposed.authority
        && current.salience === proposed.salience
        && current.epistemic === proposed.epistemic
        && current.occurredAt === proposed.occurredAt
        && current.validFrom === proposed.validFrom
        && current.validUntil === proposed.validUntil
        && JSON.stringify(current.perspective)
            === JSON.stringify(proposed.perspective)
        && JSON.stringify(current.evidence) === JSON.stringify(proposed.evidence)
}

export function createV1ReconciliationDelta(
    memoryState: NarrativeMemoryState,
    graphState: NarrativeGraphStateV2
): NarrativeGraphDeltaV2 {
    const graph = validateNarrativeGraphState(graphState)
    const operations: NarrativeGraphOperation[] = []
    const expectedFactNodeIds = new Set(memoryState.facts.map(
        (fact) => `claim:v1:${fact.id}`
    ))
    const expectedEventNodeIds = new Set(memoryState.events.map(
        (event) => `event:v1:${event.id}`
    ))
    for (const node of graph.nodes) {
        if (node.id.startsWith('claim:v1:')
            && !expectedFactNodeIds.has(node.id)) {
            throw new Error(
                `Projected narrative node is absent from v1 state: ${node.id}`
            )
        }
        if (node.id.startsWith('event:v1:')
            && !expectedEventNodeIds.has(node.id)) {
            throw new Error(
                `Projected narrative node is absent from v1 state: ${node.id}`
            )
        }
    }
    const projectedNode = (
        operation: MemoryDelta['operations'][number]
    ): AddNarrativeNodeOperation['node'] => {
        const projected = projectMemoryDeltaToNarrativeGraphDelta({
            schemaVersion: 1,
            operations: [operation],
        }, graph.storyId, graph.branchId).operations[0]
        if (projected.type !== 'add-node') {
            throw new Error('Expected a projected add-node operation')
        }
        return projected.node
    }

    for (const fact of memoryState.facts) {
        const nodeId = `claim:v1:${fact.id}`
        const addOperationId = `reconcile:v1:add:${nodeId}`
        const node = projectedNode({
            type: 'add-fact',
            operationId: addOperationId,
            factId: fact.id,
            text: fact.text,
            evidence: fact.evidence,
        })
        const current = graph.nodes.find((candidate) =>
            candidate.id === nodeId
        )
        if (!current) {
            operations.push({
                type: 'add-node',
                operationId: addOperationId,
                node,
            })
        }
        else if (!sameProjectedNodeContent(current, node)) {
            throw new Error(
                `Incompatible projected narrative node: ${nodeId}`
            )
        }
        if (fact.status === 'active') {
            if (current && (current.status !== 'active'
                || current.statusEvidence !== undefined)) {
                throw new Error(
                    `Incompatible projected narrative node: ${nodeId}`
                )
            }
            continue
        }
        if (!fact.invalidatedBy) {
            throw new Error(`Invalidated fact lacks evidence: ${fact.id}`)
        }
        if (!current || current.status === 'active') {
            operations.push({
                type: 'update-node-status',
                operationId:
                    `reconcile:v1:status:${nodeId}:invalidated`,
                nodeId,
                status: 'invalidated',
                evidence: fact.invalidatedBy.map((item) => ({ ...item })),
            })
        }
        else if (current.status !== 'invalidated'
            || JSON.stringify(current.statusEvidence)
                !== JSON.stringify(fact.invalidatedBy)) {
            throw new Error(
                `Incompatible projected narrative node: ${nodeId}`
            )
        }
    }

    for (const event of memoryState.events) {
        const nodeId = `event:v1:${event.id}`
        const operationId = `reconcile:v1:add:${nodeId}`
        const node = projectedNode({
            type: 'append-event',
            operationId,
            eventId: event.id,
            summary: event.summary,
            evidence: event.evidence,
        })
        const current = graph.nodes.find((candidate) =>
            candidate.id === nodeId
        )
        if (!current) {
            operations.push({
                type: 'add-node',
                operationId,
                node,
            })
        }
        else if (current.status !== 'active'
            || current.statusEvidence !== undefined
            || !sameProjectedNodeContent(current, node)) {
            throw new Error(
                `Incompatible projected narrative node: ${nodeId}`
            )
        }
    }

    return {
        schemaVersion: 2,
        storyId: graph.storyId,
        branchId: graph.branchId,
        operations,
    }
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
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireString(value: unknown, label: string): string {
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
    for (const key of allowedKeys) {
        if (!Object.prototype.hasOwnProperty.call(value, key)
            && ![
                'occurredAt',
                'validFrom',
                'validUntil',
                'statusEvidence',
            ].includes(key)) {
            throw new Error(`Missing ${label} field: ${key}`)
        }
    }
}

function cloneEvidence(
    value: unknown,
    operationId: string,
    branchId: string,
    available: Map<string, Set<string>>
): EvidenceRef[] {
    if (!Array.isArray(value) || value.length === 0) {
        throw new Error(`Operation ${operationId} must include evidence`)
    }
    return value.map((item) => {
        if (!isRecord(item)) {
            throw new Error(`Operation ${operationId} has invalid evidence`)
        }
        assertExactKeys(item, ['chatId', 'messageId'], 'narrative evidence')
        const evidence = {
            chatId: requireString(item.chatId, 'Evidence chatId'),
            messageId: requireString(item.messageId, 'Evidence messageId'),
        }
        if (evidence.chatId !== branchId) {
            throw new Error(
                `Narrative evidence is outside delta chat scope: ${evidence.chatId}`
            )
        }
        if (!available.get(evidence.chatId)?.has(evidence.messageId)) {
            throw new Error(
                `Unknown narrative evidence reference: ${evidence.chatId}/${evidence.messageId}`
            )
        }
        return evidence
    })
}

function availableEvidenceMap(
    evidence: readonly EvidenceRef[]
): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>()
    for (const item of evidence) {
        const chatId = requireString(item.chatId, 'Available evidence chatId')
        const messageId = requireString(
            item.messageId,
            'Available evidence messageId'
        )
        const messages = result.get(chatId) ?? new Set<string>()
        messages.add(messageId)
        result.set(chatId, messages)
    }
    return result
}

function validateProposedNode(
    graph: NarrativeGraphStateV2,
    value: unknown,
    operationId: string,
    revision: number,
    available: Map<string, Set<string>>
): NarrativeNode {
    if (!isRecord(value)) throw new Error('Narrative node must be an object')
    assertExactKeys(value, nodeKeys, 'add-node node')
    const node = structuredClone(value) as unknown as NarrativeNode
    node.evidence = cloneEvidence(
        value.evidence,
        operationId,
        graph.branchId,
        available
    )
    node.revision = revision
    const validated = validateNarrativeGraphState({
        ...graph,
        nodes: [
            ...graph.nodes.filter((candidate) => candidate.id !== node.id),
            node,
        ],
    })
    return validated.nodes.find((candidate) => candidate.id === node.id)!
}

function validateProposedEdge(
    graph: NarrativeGraphStateV2,
    value: unknown,
    operationId: string,
    revision: number,
    available: Map<string, Set<string>>
): NarrativeEdge {
    if (!isRecord(value)) throw new Error('Narrative edge must be an object')
    assertExactKeys(value, edgeKeys, 'add-edge edge')
    const edge = structuredClone(value) as unknown as NarrativeEdge
    edge.evidence = cloneEvidence(
        value.evidence,
        operationId,
        graph.branchId,
        available
    )
    edge.revision = revision
    const validated = validateNarrativeGraphState({
        ...graph,
        edges: [
            ...graph.edges.filter((candidate) => candidate.id !== edge.id),
            edge,
        ],
    })
    return validated.edges.find((candidate) => candidate.id === edge.id)!
}

function sameNodeOperationPayload(
    current: NarrativeNode,
    proposed: NarrativeNode
): boolean {
    const {
        revision: _currentRevision,
        status: _currentStatus,
        statusEvidence: _currentStatusEvidence,
        ...currentPayload
    } = current
    const {
        revision: _proposedRevision,
        status: _proposedStatus,
        statusEvidence: _proposedStatusEvidence,
        ...proposedPayload
    } = proposed
    return JSON.stringify(currentPayload) === JSON.stringify(proposedPayload)
}

function sameEdgeOperationPayload(
    current: NarrativeEdge,
    proposed: NarrativeEdge
): boolean {
    const { revision: _currentRevision, ...currentPayload } = current
    const { revision: _proposedRevision, ...proposedPayload } = proposed
    return JSON.stringify(currentPayload) === JSON.stringify(proposedPayload)
}

export function validateNarrativeGraphDelta(
    value: unknown,
    state: NarrativeGraphStateV2,
    availableEvidence: readonly EvidenceRef[]
): NarrativeGraphDeltaV2 {
    const graph = validateNarrativeGraphState(state)
    if (!isRecord(value) || value.schemaVersion !== 2) {
        throw new Error('Unsupported narrative graph delta schema version')
    }
    assertExactKeys(
        value,
        ['schemaVersion', 'storyId', 'branchId', 'operations'],
        'narrative graph delta'
    )
    const storyId = requireString(value.storyId, 'Delta storyId')
    const branchId = requireString(value.branchId, 'Delta branchId')
    if (storyId !== graph.storyId || branchId !== graph.branchId) {
        throw new Error('Narrative graph delta is outside graph scope')
    }
    if (!Array.isArray(value.operations)) {
        throw new Error('Narrative graph delta operations must be an array')
    }
    const operationIds = new Set<string>()
    const available = availableEvidenceMap(availableEvidence)
    const operations: NarrativeGraphOperation[] = []
    const validationGraph = structuredClone(graph)
    const applied = new Set(graph.appliedOperationIds)
    const bindings = new Map(
        (graph.appliedOperationBindings ?? []).map(
            (binding) => [binding.operationId, binding]
        )
    )
    const revision = graph.revision + 1

    for (const raw of value.operations) {
        if (!isRecord(raw)) {
            throw new Error('Narrative graph operation must be an object')
        }
        const type = raw.type
        const keys = type === 'add-node'
            ? ['type', 'operationId', 'node']
            : type === 'update-node-status'
                ? ['type', 'operationId', 'nodeId', 'status', 'evidence']
                : type === 'add-edge'
                    ? ['type', 'operationId', 'edge']
                    : null
        if (!keys) {
            throw new Error(
                `Unsupported narrative graph operation: ${String(type)}`
            )
        }
        assertExactKeys(raw, keys, String(type))
        const operationId = requireString(raw.operationId, 'Operation ID')
        if (operationIds.has(operationId)) {
            throw new Error(`Duplicate narrative operation ID: ${operationId}`)
        }
        operationIds.add(operationId)
        const alreadyApplied = applied.has(operationId)

        if (type === 'add-node') {
            if (isRecord(raw.node)
                && raw.node.statusEvidence !== undefined) {
                throw new Error(
                    'Added narrative nodes cannot set status evidence'
                )
            }
            const validatedNode = validateProposedNode(
                validationGraph,
                raw.node,
                operationId,
                revision,
                available
            )
            const { revision: _revision, ...node } = validatedNode
            if (node.status !== 'active') {
                throw new Error('Added narrative nodes must be active')
            }
            if (alreadyApplied) {
                const binding = bindings.get(operationId)
                if (binding && (binding.type !== type
                    || binding.targetId !== node.id)) {
                    throw new Error('Narrative operation payload mismatch')
                }
                const current = validationGraph.nodes.find(
                    (item) => item.id === node.id
                )
                if (!current
                    || !sameNodeOperationPayload(current, validatedNode)) {
                    throw new Error('Narrative operation payload mismatch')
                }
            }
            else {
                if (validationGraph.nodes.some((item) => item.id === node.id)) {
                    throw new Error(`Narrative node already exists: ${node.id}`)
                }
                validationGraph.nodes.push(validatedNode)
            }
            operations.push({ type, operationId, node })
        }
        else if (type === 'add-edge') {
            const validatedEdge = validateProposedEdge(
                validationGraph,
                raw.edge,
                operationId,
                revision,
                available
            )
            const { revision: _revision, ...edge } = validatedEdge
            if (alreadyApplied) {
                const binding = bindings.get(operationId)
                if (binding && (binding.type !== type
                    || binding.targetId !== edge.id)) {
                    throw new Error('Narrative operation payload mismatch')
                }
                const current = validationGraph.edges.find(
                    (item) => item.id === edge.id
                )
                if (!current
                    || !sameEdgeOperationPayload(current, validatedEdge)) {
                    throw new Error('Narrative operation payload mismatch')
                }
            }
            else {
                if (validationGraph.edges.some((item) => item.id === edge.id)) {
                    throw new Error(`Narrative edge already exists: ${edge.id}`)
                }
                validationGraph.edges.push(validatedEdge)
            }
            operations.push({ type, operationId, edge })
        }
        else {
            const nodeId = requireString(raw.nodeId, 'Narrative node ID')
            if (!['resolved', 'invalidated', 'superseded'].includes(
                String(raw.status)
            )) {
                throw new Error('Unsupported narrative node status update')
            }
            const evidence = cloneEvidence(
                raw.evidence,
                operationId,
                branchId,
                available
            )
            const node = validationGraph.nodes.find(
                (candidate) => candidate.id === nodeId
            )
            if (alreadyApplied) {
                const binding = bindings.get(operationId)
                if (binding && (binding.type !== type
                    || binding.targetId !== nodeId)) {
                    throw new Error('Narrative operation payload mismatch')
                }
                if (!node
                    || node.status !== raw.status
                    || JSON.stringify(node.statusEvidence)
                        !== JSON.stringify(evidence)) {
                    throw new Error('Narrative operation payload mismatch')
                }
            }
            else {
                if (!node || node.status !== 'active') {
                    throw new Error(
                        `Cannot update unknown or inactive narrative node: ${nodeId}`
                    )
                }
                node.status = raw.status as Exclude<
                    NarrativeNodeStatus,
                    'active'
                >
                node.revision = revision
            }
            operations.push({
                type: 'update-node-status',
                operationId,
                nodeId,
                status: raw.status as Exclude<NarrativeNodeStatus, 'active'>,
                evidence,
            })
        }
    }
    validateNarrativeGraphState(validationGraph)
    return { schemaVersion: 2, storyId, branchId, operations }
}

export function applyNarrativeGraphDelta(
    state: NarrativeGraphStateV2,
    delta: unknown,
    availableEvidence: readonly EvidenceRef[]
): NarrativeGraphStateV2 {
    const graph = validateNarrativeGraphState(state)
    const parsed = validateNarrativeGraphDelta(
        delta,
        graph,
        availableEvidence
    )
    const applied = new Set(graph.appliedOperationIds)
    const newOperations = parsed.operations.filter(
        (operation) => !applied.has(operation.operationId)
    )
    if (newOperations.length === 0) return graph

    const revision = graph.revision + 1
    const result = structuredClone(graph)
    result.revision = revision
    result.appliedOperationBindings ??= []
    for (const operation of newOperations) {
        if (operation.type === 'add-node') {
            result.nodes.push({ ...operation.node, revision })
        }
        else if (operation.type === 'add-edge') {
            result.edges.push({ ...operation.edge, revision })
        }
        else {
            const node = result.nodes.find(
                (candidate) => candidate.id === operation.nodeId
            )
            if (!node) throw new Error('Validated narrative node was not found')
            node.status = operation.status
            node.statusEvidence = operation.evidence.map(
                (item) => ({ ...item })
            )
            node.revision = revision
        }
        result.appliedOperationIds.push(operation.operationId)
        result.appliedOperationBindings.push({
            operationId: operation.operationId,
            type: operation.type,
            targetId: operation.type === 'add-node'
                ? operation.node.id
                : operation.type === 'add-edge'
                    ? operation.edge.id
                    : operation.nodeId,
        })
    }
    return validateNarrativeGraphState(result)
}
