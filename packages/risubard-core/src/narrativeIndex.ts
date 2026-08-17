import {
    validateNarrativeGraphState,
    type NarrativeEdge,
    type NarrativeGraphStateV2,
    type NarrativeNode,
} from './narrativeGraph'
import type {
    NarrativeGraphOperation,
} from './narrativeDelta'

export interface NarrativeGraphIndex {
    storyId: string
    branchId: string
    revision: number
    nodeById: Record<string, NarrativeNode>
    postingMembersByEntity: Record<string, string[]>
    postingMembersByTerm: Record<string, string[]>
    postingsByEntity: Record<string, string[]>
    postingsByTerm: Record<string, string[]>
    edgesByNode: Record<string, NarrativeEdge[]>
    activeStateMembersBySubject: Record<string, string[]>
    openThreadMembersByEntity: Record<string, string[]>
    activeStatesBySubject: Record<string, string[]>
    openThreadsByEntity: Record<string, string[]>
    estimatedTokensByNode: Record<string, number>
    renderedCompactNode: Record<string, string>
}

export function compareNarrativeIds(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0
}

export function normalizeNarrativeTerms(text: string): string[] {
    return [...new Set(
        (text.toLowerCase().match(/[\p{L}\p{N}_:-]+/gu) ?? [])
            .filter((term) => term.length > 0)
    )].sort()
}

function addPosting(
    postings: Record<string, Set<string>>,
    key: string,
    nodeId: string
): void {
    if (!postings[key]) postings[key] = new Set()
    postings[key].add(nodeId)
}

function sortPostings(
    postings: Record<string, Iterable<string>>,
    nodeById: Record<string, NarrativeNode>,
    limit = 16
): Record<string, string[]> {
    const kindPriority: Record<NarrativeNode['kind'], number> = {
        state: 5,
        thread: 4,
        claim: 3,
        event: 2,
        entity: 1,
    }
    const result: Record<string, string[]> = Object.create(null)
    for (const key of Object.keys(postings).sort()) {
        result[key] = [...postings[key]].sort((leftId, rightId) => {
            const left = nodeById[leftId]
            const right = nodeById[rightId]
            return Number(right.status === 'active')
                - Number(left.status === 'active')
                || kindPriority[right.kind] - kindPriority[left.kind]
                || right.salience - left.salience
                || (right.occurredAt ?? 0) - (left.occurredAt ?? 0)
                || compareNarrativeIds(leftId, rightId)
        }).slice(0, limit).sort()
    }
    return result
}

function materializePostingMembers(
    postings: Record<string, Set<string>>
): Record<string, string[]> {
    const result: Record<string, string[]> = Object.create(null)
    for (const key of Object.keys(postings).sort()) {
        result[key] = [...postings[key]].sort(compareNarrativeIds)
    }
    return result
}

function perspectiveLabel(node: NarrativeNode): string {
    return node.perspective.kind === 'character'
        ? node.perspective.entityId
        : 'omniscient'
}

export function renderCompactNarrativeNode(node: NarrativeNode): string {
    if (node.kind === 'claim' && node.subtype === 'belief') {
        return `[Belief — ${perspectiveLabel(node)}] ${node.summary}`
    }
    if (node.kind === 'claim') return `[Fact] ${node.summary}`
    if (node.kind === 'state') return `[Relationship state] ${node.summary}`
    if (node.kind === 'thread') {
        return `[Open ${node.subtype}] ${node.summary}`
    }
    if (node.kind === 'event') return `[Event] ${node.summary}`
    return `[Character] ${node.summary}`
}

export function estimateNarrativeTokens(content: string): number {
    return Math.max(1, Math.ceil(content.length / 4))
}

export function buildNarrativeIndex(
    state: NarrativeGraphStateV2
): NarrativeGraphIndex {
    const graph = validateNarrativeGraphState(state)
    const sortedNodes = [...graph.nodes].sort((left, right) =>
        compareNarrativeIds(left.id, right.id)
    )
    const sortedEdges = [...graph.edges].sort((left, right) =>
        compareNarrativeIds(left.id, right.id)
    )
    const nodeById: Record<string, NarrativeNode> = Object.create(null)
    const postingsByTerm: Record<string, Set<string>> = Object.create(null)
    const postingsByEntity: Record<string, Set<string>> = Object.create(null)
    const edgesByNode: Record<string, NarrativeEdge[]> = Object.create(null)
    const activeStatesBySubject: Record<string, Set<string>> =
        Object.create(null)
    const openThreadsByEntity: Record<string, Set<string>> =
        Object.create(null)
    const estimatedTokensByNode: Record<string, number> = Object.create(null)
    const renderedCompactNode: Record<string, string> = Object.create(null)

    for (const node of sortedNodes) {
        nodeById[node.id] = node
        edgesByNode[node.id] = []
        if (node.kind === 'entity') {
            addPosting(postingsByEntity, node.id, node.id)
        }
        for (const term of normalizeNarrativeTerms(
            `${node.title} ${node.summary}`
        )) {
            addPosting(postingsByTerm, term, node.id)
        }
        const compact = renderCompactNarrativeNode(node)
        renderedCompactNode[node.id] = compact
        estimatedTokensByNode[node.id] = estimateNarrativeTokens(compact)
    }

    for (const edge of sortedEdges) {
        edgesByNode[edge.sourceId].push(edge)
        edgesByNode[edge.targetId].push(edge)
        const source = nodeById[edge.sourceId]
        const target = nodeById[edge.targetId]
        const entity = source.kind === 'entity'
            ? source
            : target.kind === 'entity'
                ? target
                : null
        const related = source.kind === 'entity' ? target : source
        if (entity) {
            addPosting(postingsByEntity, entity.id, related.id)
            addPosting(postingsByEntity, entity.id, entity.id)
            if (related.kind === 'state' && related.status === 'active') {
                addPosting(activeStatesBySubject, entity.id, related.id)
            }
            if (related.kind === 'thread' && related.status === 'active') {
                addPosting(openThreadsByEntity, entity.id, related.id)
            }
        }
    }

    for (const nodeId of Object.keys(edgesByNode)) {
        edgesByNode[nodeId].sort((left, right) =>
            compareNarrativeIds(left.id, right.id)
        )
    }

    const postingMembersByEntity = materializePostingMembers(postingsByEntity)
    const postingMembersByTerm = materializePostingMembers(postingsByTerm)
    const activeStateMembersBySubject = materializePostingMembers(
        activeStatesBySubject
    )
    const openThreadMembersByEntity = materializePostingMembers(
        openThreadsByEntity
    )
    return {
        storyId: graph.storyId,
        branchId: graph.branchId,
        revision: graph.revision,
        nodeById,
        postingMembersByEntity,
        postingMembersByTerm,
        postingsByEntity: sortPostings(postingMembersByEntity, nodeById),
        postingsByTerm: sortPostings(postingMembersByTerm, nodeById),
        edgesByNode: Object.keys(edgesByNode).sort().reduce(
            (result, nodeId) => {
                result[nodeId] = edgesByNode[nodeId]
                return result
            },
            Object.create(null) as Record<string, NarrativeEdge[]>
        ),
        activeStateMembersBySubject,
        openThreadMembersByEntity,
        activeStatesBySubject: sortPostings(
            activeStateMembersBySubject,
            nodeById
        ),
        openThreadsByEntity: sortPostings(
            openThreadMembersByEntity,
            nodeById
        ),
        estimatedTokensByNode,
        renderedCompactNode,
    }
}

function cloneNodeRecord(
    value: Record<string, NarrativeNode>
): Record<string, NarrativeNode> {
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = structuredClone(value[key])
        return result
    }, Object.create(null) as Record<string, NarrativeNode>)
}

function cloneEdgeRecord(
    value: Record<string, NarrativeEdge[]>
): Record<string, NarrativeEdge[]> {
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = structuredClone(value[key])
        return result
    }, Object.create(null) as Record<string, NarrativeEdge[]>)
}

function clonePostingRecord(
    value: Record<string, string[]>
): Record<string, string[]> {
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = [...value[key]]
        return result
    }, Object.create(null) as Record<string, string[]>)
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
    return Object.keys(value).sort().reduce((result, key) => {
        result[key] = value[key]
        return result
    }, Object.create(null) as Record<string, T>)
}

function addPostingMember(
    postings: Record<string, string[]>,
    key: string,
    nodeId: string
): void {
    const current = postings[key] ?? []
    if (current.includes(nodeId)) return
    postings[key] = [...current, nodeId].sort(compareNarrativeIds)
}

function removePostingMember(
    postings: Record<string, string[]>,
    key: string,
    nodeId: string
): void {
    const current = postings[key]
    if (!current) return
    const next = current.filter((candidate) => candidate !== nodeId)
    if (next.length === 0) delete postings[key]
    else postings[key] = next
}

function refreshPosting(
    publicPostings: Record<string, string[]>,
    members: Record<string, string[]>,
    nodeById: Record<string, NarrativeNode>,
    key: string
): void {
    if (!members[key]) {
        delete publicPostings[key]
        return
    }
    publicPostings[key] = sortPostings(
        { [key]: members[key] },
        nodeById
    )[key]
}

function connectedEntityIds(
    nodeId: string,
    edgesByNode: Record<string, NarrativeEdge[]>,
    nodeById: Record<string, NarrativeNode>
): string[] {
    const result = new Set<string>()
    for (const edge of edgesByNode[nodeId] ?? []) {
        const otherId = edge.sourceId === nodeId
            ? edge.targetId
            : edge.sourceId
        if (nodeById[otherId]?.kind === 'entity') result.add(otherId)
    }
    return [...result].sort(compareNarrativeIds)
}

export function updateNarrativeIndex(
    previousIndex: NarrativeGraphIndex,
    previousState: NarrativeGraphStateV2,
    nextState: NarrativeGraphStateV2,
    operations: readonly NarrativeGraphOperation[]
): NarrativeGraphIndex {
    if (previousIndex.storyId !== previousState.storyId
        || previousIndex.branchId !== previousState.branchId
        || previousIndex.revision !== previousState.revision
        || nextState.storyId !== previousState.storyId
        || nextState.branchId !== previousState.branchId) {
        throw new Error('Narrative index update scope does not match state')
    }
    const nodeById = cloneNodeRecord(previousIndex.nodeById)
    const edgesByNode = cloneEdgeRecord(previousIndex.edgesByNode)
    const postingMembersByEntity = clonePostingRecord(
        previousIndex.postingMembersByEntity
    )
    const postingMembersByTerm = clonePostingRecord(
        previousIndex.postingMembersByTerm
    )
    const activeStateMembersBySubject = clonePostingRecord(
        previousIndex.activeStateMembersBySubject
    )
    const openThreadMembersByEntity = clonePostingRecord(
        previousIndex.openThreadMembersByEntity
    )
    const postingsByEntity = clonePostingRecord(
        previousIndex.postingsByEntity
    )
    const postingsByTerm = clonePostingRecord(previousIndex.postingsByTerm)
    const activeStatesBySubject = clonePostingRecord(
        previousIndex.activeStatesBySubject
    )
    const openThreadsByEntity = clonePostingRecord(
        previousIndex.openThreadsByEntity
    )
    const estimatedTokensByNode = {
        ...previousIndex.estimatedTokensByNode,
    }
    const renderedCompactNode = {
        ...previousIndex.renderedCompactNode,
    }
    const alreadyApplied = new Set(previousState.appliedOperationIds)
    const pending = operations.filter(
        (operation) => !alreadyApplied.has(operation.operationId)
    )

    for (const operation of pending) {
        if (operation.type === 'add-node') {
            const node: NarrativeNode = structuredClone({
                ...operation.node,
                revision: nextState.revision,
            })
            nodeById[node.id] = node
            edgesByNode[node.id] = []
            if (node.kind === 'entity') {
                addPostingMember(
                    postingMembersByEntity,
                    node.id,
                    node.id
                )
                refreshPosting(
                    postingsByEntity,
                    postingMembersByEntity,
                    nodeById,
                    node.id
                )
            }
            for (const term of normalizeNarrativeTerms(
                `${node.title} ${node.summary}`
            )) {
                addPostingMember(postingMembersByTerm, term, node.id)
                refreshPosting(
                    postingsByTerm,
                    postingMembersByTerm,
                    nodeById,
                    term
                )
            }
            const compact = renderCompactNarrativeNode(node)
            renderedCompactNode[node.id] = compact
            estimatedTokensByNode[node.id] = estimateNarrativeTokens(compact)
            continue
        }
        if (operation.type === 'add-edge') {
            const edge: NarrativeEdge = structuredClone({
                ...operation.edge,
                revision: nextState.revision,
            })
            for (const nodeId of [edge.sourceId, edge.targetId]) {
                edgesByNode[nodeId] = [
                    ...(edgesByNode[nodeId] ?? []),
                    edge,
                ].sort((left, right) =>
                    compareNarrativeIds(left.id, right.id)
                )
            }
            const source = nodeById[edge.sourceId]
            const target = nodeById[edge.targetId]
            const entity = source.kind === 'entity'
                ? source
                : target.kind === 'entity'
                    ? target
                    : null
            const related = source.kind === 'entity' ? target : source
            if (entity) {
                addPostingMember(
                    postingMembersByEntity,
                    entity.id,
                    entity.id
                )
                addPostingMember(
                    postingMembersByEntity,
                    entity.id,
                    related.id
                )
                refreshPosting(
                    postingsByEntity,
                    postingMembersByEntity,
                    nodeById,
                    entity.id
                )
                if (related.kind === 'state'
                    && related.status === 'active') {
                    addPostingMember(
                        activeStateMembersBySubject,
                        entity.id,
                        related.id
                    )
                    refreshPosting(
                        activeStatesBySubject,
                        activeStateMembersBySubject,
                        nodeById,
                        entity.id
                    )
                }
                if (related.kind === 'thread'
                    && related.status === 'active') {
                    addPostingMember(
                        openThreadMembersByEntity,
                        entity.id,
                        related.id
                    )
                    refreshPosting(
                        openThreadsByEntity,
                        openThreadMembersByEntity,
                        nodeById,
                        entity.id
                    )
                }
            }
            continue
        }

        const current = nodeById[operation.nodeId]
        if (!current) {
            throw new Error(
                `Narrative index is missing node: ${operation.nodeId}`
            )
        }
        const node: NarrativeNode = {
            ...current,
            status: operation.status,
            statusEvidence: operation.evidence.map((item) => ({ ...item })),
            revision: nextState.revision,
        }
        nodeById[node.id] = node
        for (const term of normalizeNarrativeTerms(
            `${node.title} ${node.summary}`
        )) {
            refreshPosting(
                postingsByTerm,
                postingMembersByTerm,
                nodeById,
                term
            )
        }
        for (const entityId of connectedEntityIds(
            node.id,
            edgesByNode,
            nodeById
        )) {
            refreshPosting(
                postingsByEntity,
                postingMembersByEntity,
                nodeById,
                entityId
            )
            if (node.kind === 'state') {
                removePostingMember(
                    activeStateMembersBySubject,
                    entityId,
                    node.id
                )
                refreshPosting(
                    activeStatesBySubject,
                    activeStateMembersBySubject,
                    nodeById,
                    entityId
                )
            }
            if (node.kind === 'thread') {
                removePostingMember(
                    openThreadMembersByEntity,
                    entityId,
                    node.id
                )
                refreshPosting(
                    openThreadsByEntity,
                    openThreadMembersByEntity,
                    nodeById,
                    entityId
                )
            }
        }
        const compact = renderCompactNarrativeNode(node)
        renderedCompactNode[node.id] = compact
        estimatedTokensByNode[node.id] = estimateNarrativeTokens(compact)
    }

    return {
        storyId: nextState.storyId,
        branchId: nextState.branchId,
        revision: nextState.revision,
        nodeById: sortRecord(nodeById),
        postingMembersByEntity: sortRecord(postingMembersByEntity),
        postingMembersByTerm: sortRecord(postingMembersByTerm),
        postingsByEntity: sortRecord(postingsByEntity),
        postingsByTerm: sortRecord(postingsByTerm),
        edgesByNode: sortRecord(edgesByNode),
        activeStateMembersBySubject: sortRecord(
            activeStateMembersBySubject
        ),
        openThreadMembersByEntity: sortRecord(openThreadMembersByEntity),
        activeStatesBySubject: sortRecord(activeStatesBySubject),
        openThreadsByEntity: sortRecord(openThreadsByEntity),
        estimatedTokensByNode: sortRecord(estimatedTokensByNode),
        renderedCompactNode: sortRecord(renderedCompactNode),
    }
}
