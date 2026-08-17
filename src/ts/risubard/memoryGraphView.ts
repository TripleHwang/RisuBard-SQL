import type {
    NarrativeEdge,
    NarrativeGraphStateV2,
    NarrativeNode,
} from '../../../packages/risubard-core/src/narrativeGraph'
import {
    compareNarrativeIds,
} from '../../../packages/risubard-core/src/narrativeIndex'

export const MEMORY_GRAPH_NODE_LIMIT = 96
export const MEMORY_GRAPH_EDGE_LIMIT = 192
export const MEMORY_GRAPH_EVIDENCE_LIMIT = 16
export type NarrativeGraphViewSnapshot = Omit<
    NarrativeGraphStateV2,
    'appliedOperationIds' | 'appliedOperationBindings'
>

export type NarrativeGraphKindFilter = NarrativeNode['kind'] | 'all'
export type NarrativeGraphStatusFilter = NarrativeNode['status'] | 'all'

export interface NarrativeGraphProjectionOptions {
    query?: string
    kind?: NarrativeGraphKindFilter
    status?: NarrativeGraphStatusFilter
}

export interface PositionedNarrativeNode extends NarrativeNode {
    x: number
    y: number
    connectedCount: number
}

export interface NarrativeGraphProjection {
    totalNodeCount: number
    totalEdgeCount: number
    matchingNodeCount: number
    laneCount: number
    visibleNodes: PositionedNarrativeNode[]
    visibleEdges: NarrativeEdge[]
    truncated: boolean
}

const kindOrder: NarrativeNode['kind'][] = [
    'entity',
    'event',
    'state',
    'claim',
    'thread',
]
const layoutMinimum = 12
const layoutSpan = 76

function matchesQuery(node: NarrativeNode, query: string): boolean {
    if (!query) return true
    return [
        node.id,
        node.kind,
        node.subtype,
        node.title,
        node.summary,
    ].some((value) => value?.toLowerCase().includes(query))
}

function positionNodes(nodes: NarrativeNode[]): {
    laneCount: number
    nodes: PositionedNarrativeNode[]
} {
    const groups = kindOrder
        .map((kind) => nodes.filter((node) => node.kind === kind))
        .filter((group) => group.length > 0)
    const lanes = groups.flatMap((group) =>
        Array.from(
            { length: Math.ceil(group.length / 6) },
            (_, index) => group.slice(index * 6, index * 6 + 6)
        )
    )
    return {
        laneCount: lanes.length,
        nodes: lanes.flatMap((lane, laneIndex) => {
        const x = lanes.length === 1
            ? 50
            : layoutMinimum + laneIndex * layoutSpan / (lanes.length - 1)
        return lane.map((node, rowIndex) => ({
            ...node,
            x,
            y: lane.length === 1
                ? 50
                : layoutMinimum
                    + rowIndex * layoutSpan / (lane.length - 1),
            connectedCount: 0,
        }))
        }),
    }
}

export function createNarrativeGraphProjection(
    state: NarrativeGraphViewSnapshot,
    options: NarrativeGraphProjectionOptions = {}
): NarrativeGraphProjection {
    const query = options.query?.trim().toLowerCase() ?? ''
    const kind = options.kind ?? 'all'
    const status = options.status ?? 'all'
    const matching = state.nodes
        .filter((node) => kind === 'all' || node.kind === kind)
        .filter((node) => status === 'all' || node.status === status)
        .filter((node) => matchesQuery(node, query))
        .sort((left, right) =>
            right.salience - left.salience
            || right.revision - left.revision
            || compareNarrativeIds(left.id, right.id)
        )
    const selected = matching.slice(0, MEMORY_GRAPH_NODE_LIMIT)
    const selectedIds = new Set(selected.map((node) => node.id))
    const matchingEdges = state.edges
        .filter((edge) =>
            selectedIds.has(edge.sourceId)
            && selectedIds.has(edge.targetId)
        )
        .sort((left, right) => compareNarrativeIds(left.id, right.id))
    const visibleEdges = matchingEdges.slice(0, MEMORY_GRAPH_EDGE_LIMIT)
    const connectionCounts = new Map<string, number>()
    for (const edge of visibleEdges) {
        connectionCounts.set(
            edge.sourceId,
            (connectionCounts.get(edge.sourceId) ?? 0) + 1
        )
        connectionCounts.set(
            edge.targetId,
            (connectionCounts.get(edge.targetId) ?? 0) + 1
        )
    }
    const positioned = positionNodes(selected)
    const visibleNodes = positioned.nodes.map((node) => ({
        ...node,
        connectedCount: connectionCounts.get(node.id) ?? 0,
    }))
    return {
        totalNodeCount: state.nodes.length,
        totalEdgeCount: state.edges.length,
        matchingNodeCount: matching.length,
        laneCount: positioned.laneCount,
        visibleNodes,
        visibleEdges,
        truncated: matching.length > MEMORY_GRAPH_NODE_LIMIT
            || matchingEdges.length > MEMORY_GRAPH_EDGE_LIMIT,
    }
}
