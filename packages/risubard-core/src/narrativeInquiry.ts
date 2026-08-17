import type { ContextSource } from './contextCompiler'
import type {
    NarrativeNode,
    NarrativeNodeKind,
} from './narrativeGraph'
import type { NarrativeGraphIndex } from './narrativeIndex'
import {
    compareNarrativeIds,
    normalizeNarrativeTerms,
} from './narrativeIndex'

export interface NarrativeInquiryInput {
    entityIds: readonly string[]
    openThreadIds: readonly string[]
    terms: readonly string[]
    perspectiveEntityIds?: readonly string[]
    excludeUnmarkedOmniscientClaims?: boolean
    stickyNodeIds?: readonly string[]
    tokenBudget: number
    maxSelectedNodes?: number
    postingLimit?: number
    directCandidateLimit?: number
    candidateLimit?: number
    edgeLimitPerNode?: number
    hopLimit?: 0 | 1
    kindLimits?: Readonly<Record<NarrativeNodeKind, number>>
}

export interface RetrievedNarrativeMemory {
    node: NarrativeNode
    content: string
    tokens: number
    score: number
    hop: number
}

export interface NarrativeInquiryMetrics {
    candidateCount: number
    inspectedNodeCount: number
    inspectedEdgeCount: number
    selectedNodeCount: number
    selectedTokens: number
    hopCount: number
    auxiliaryModelCalls: 0
}

export interface NarrativeInquiryResult {
    selected: RetrievedNarrativeMemory[]
    metrics: NarrativeInquiryMetrics
}

const defaultKindLimits: Record<NarrativeNodeKind, number> = {
    entity: 0,
    event: 8,
    state: 8,
    claim: 8,
    thread: 8,
}

function boundedInteger(
    value: number | undefined,
    fallback: number,
    label: string,
    maximum = Number.MAX_SAFE_INTEGER
): number {
    const selected = value ?? fallback
    if (!Number.isSafeInteger(selected)
        || selected < 0
        || selected > maximum) {
        throw new Error(`${label} is outside its supported range`)
    }
    return selected
}

function isVisible(
    node: NarrativeNode,
    input: NarrativeInquiryInput
): boolean {
    if (node.status !== 'active') return false
    if (node.kind === 'claim'
        && node.perspective.kind === 'omniscient'
        && input.excludeUnmarkedOmniscientClaims) {
        return false
    }
    if (node.perspective.kind !== 'character') return true
    const perspectives = input.perspectiveEntityIds
    return perspectives?.includes(node.perspective.entityId) ?? false
}

function assertSeedArray(
    values: readonly string[] | undefined,
    limit: number,
    label: string,
    maxCharacters = 256
): void {
    if (!values) return
    if (values.length > limit) {
        throw new Error(`${label} count exceeds ${limit}`)
    }
    for (const value of values) {
        if (typeof value !== 'string'
            || value.trim().length === 0
            || value.length > maxCharacters) {
            throw new Error(
                maxCharacters === 64
                    ? `${label} exceeds 64 characters`
                    : `${label} is invalid`
            )
        }
    }
}

function candidateScore(
    node: NarrativeNode,
    input: NarrativeInquiryInput,
    index: NarrativeGraphIndex,
    terms: readonly string[],
    hop: number
): number {
    let score = node.salience * 2 - hop * 10
    if (input.entityIds.some((entityId) =>
        index.postingsByEntity[entityId]?.includes(node.id))) {
        score += 100
    }
    if (input.openThreadIds.includes(node.id)) score += 100
    if (terms.some((term) =>
        index.postingsByTerm[term]?.includes(node.id))) {
        score += 40
    }
    if (node.kind === 'state') score += 35
    if (node.kind === 'thread') score += 30
    if (node.subtype === 'belief') score += 25
    if (input.stickyNodeIds?.includes(node.id)) score += 15
    return score
}

export function inquireNarrativeMemory(
    index: NarrativeGraphIndex,
    input: NarrativeInquiryInput
): NarrativeInquiryResult {
    assertSeedArray(input.entityIds, 16, 'Entity seed')
    assertSeedArray(input.openThreadIds, 16, 'Open thread seed')
    assertSeedArray(input.stickyNodeIds, 16, 'Sticky node seed')
    assertSeedArray(input.perspectiveEntityIds, 16, 'Perspective entity')
    assertSeedArray(input.terms, 32, 'Narrative term seed', 64)
    const postingLimit = boundedInteger(
        input.postingLimit,
        16,
        'Posting limit',
        16
    )
    const directCandidateLimit = boundedInteger(
        input.directCandidateLimit,
        32,
        'Direct candidate limit',
        32
    )
    const candidateLimit = boundedInteger(
        input.candidateLimit,
        64,
        'Candidate limit',
        64
    )
    const edgeLimitPerNode = boundedInteger(
        input.edgeLimitPerNode,
        16,
        'Edge limit',
        16
    )
    const hopLimit = boundedInteger(input.hopLimit, 1, 'Hop limit', 1)
    const maxSelectedNodes = boundedInteger(
        input.maxSelectedNodes,
        16,
        'Selected node limit',
        64
    )
    const tokenBudget = boundedInteger(
        input.tokenBudget,
        0,
        'Narrative token budget'
    )
    const kindLimits = input.kindLimits ?? defaultKindLimits
    for (const kind of Object.keys(defaultKindLimits) as NarrativeNodeKind[]) {
        boundedInteger(kindLimits[kind], 0, `${kind} quota`, 64)
    }
    if (candidateLimit < directCandidateLimit) {
        throw new Error('Candidate limit cannot be below direct candidate limit')
    }

    const terms = normalizeNarrativeTerms(input.terms.join(' '))
    const candidateHops = new Map<string, number>()
    const addDirect = (nodeId: string) => {
        if (candidateHops.size >= directCandidateLimit) return
        if (index.nodeById[nodeId]) candidateHops.set(nodeId, 0)
    }
    for (const entityId of [...new Set(input.entityIds)].sort()) {
        addDirect(entityId)
        for (const nodeId of (
            index.postingsByEntity[entityId] ?? []
        ).slice(0, postingLimit)) {
            addDirect(nodeId)
        }
    }
    for (const threadId of [...new Set(input.openThreadIds)].sort()) {
        addDirect(threadId)
    }
    for (const term of terms) {
        for (const nodeId of (
            index.postingsByTerm[term] ?? []
        ).slice(0, postingLimit)) {
            addDirect(nodeId)
        }
    }
    for (const stickyId of [...new Set(input.stickyNodeIds ?? [])].sort()) {
        addDirect(stickyId)
    }

    let inspectedEdgeCount = 0
    if (hopLimit === 1) {
        const directIds = [...candidateHops.keys()].sort()
        for (const nodeId of directIds) {
            for (const edge of (
                index.edgesByNode[nodeId] ?? []
            ).slice(0, edgeLimitPerNode)) {
                inspectedEdgeCount += 1
                if (candidateHops.size >= candidateLimit) break
                const adjacentId = edge.sourceId === nodeId
                    ? edge.targetId
                    : edge.sourceId
                if (!candidateHops.has(adjacentId)) {
                    candidateHops.set(adjacentId, 1)
                }
            }
            if (candidateHops.size >= candidateLimit) break
        }
    }

    const candidates = [...candidateHops].map(([nodeId, hop]) => {
        const node = index.nodeById[nodeId]
        return {
            node,
            content: index.renderedCompactNode[nodeId],
            tokens: index.estimatedTokensByNode[nodeId],
            score: candidateScore(node, input, index, terms, hop),
            hop,
        }
    }).filter((candidate) => isVisible(candidate.node, input))
        .sort((left, right) =>
            right.score - left.score
            || (right.node.occurredAt ?? 0) - (left.node.occurredAt ?? 0)
            || compareNarrativeIds(left.node.id, right.node.id)
        )

    const selected: RetrievedNarrativeMemory[] = []
    const selectedByKind: Record<NarrativeNodeKind, number> = {
        entity: 0,
        event: 0,
        state: 0,
        claim: 0,
        thread: 0,
    }
    let selectedTokens = 0
    for (const candidate of candidates) {
        if (selected.length >= maxSelectedNodes) break
        if (selectedByKind[candidate.node.kind]
            >= kindLimits[candidate.node.kind]) {
            continue
        }
        if (selectedTokens + candidate.tokens > tokenBudget) continue
        selected.push(candidate)
        selectedByKind[candidate.node.kind] += 1
        selectedTokens += candidate.tokens
    }

    return {
        selected,
        metrics: {
            candidateCount: candidateHops.size,
            inspectedNodeCount: candidateHops.size,
            inspectedEdgeCount,
            selectedNodeCount: selected.length,
            selectedTokens,
            hopCount: hopLimit,
            auxiliaryModelCalls: 0,
        },
    }
}

export function narrativeInquiryToContextSources(
    result: NarrativeInquiryResult
): ContextSource[] {
    return result.selected.map((item) => ({
        id: `narrative-memory:${item.node.id}`,
        kind: 'memory',
        role: 'system',
        content: item.content,
        tokens: item.tokens,
        priority: item.score,
        occurredAt: item.node.occurredAt,
    }))
}
