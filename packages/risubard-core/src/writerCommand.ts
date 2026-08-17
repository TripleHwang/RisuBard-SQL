import type {
    EvidenceRef,
    MemoryDelta,
} from './memoryDelta'
import {
    projectMemoryDeltaToNarrativeGraphDelta,
    validateNarrativeGraphDelta,
    type NarrativeGraphDeltaV2,
} from './narrativeDelta'
import {
    validateNarrativeGraphState,
    type NarrativeGraphStateV2,
    type NarrativeNode,
} from './narrativeGraph'

export interface PromoteCharacterCommand {
    schemaVersion: 1
    type: 'promote-character'
    commandId: string
    storyId: string
    branchId: string
    sourceNodeId: string
    name: string
    summary: string
    salience: number
}

export interface CompiledWriterCommand {
    command: PromoteCharacterCommand
    availableEvidence: EvidenceRef[]
    memoryDelta: MemoryDelta
    graphDelta: NarrativeGraphDeltaV2
}

const commandKeys = [
    'schemaVersion',
    'type',
    'commandId',
    'storyId',
    'branchId',
    'sourceNodeId',
    'name',
    'summary',
    'salience',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireExactKeys(value: Record<string, unknown>): void {
    const keys = Object.keys(value)
    if (keys.length !== commandKeys.length
        || keys.some((key) => !commandKeys.includes(
            key as typeof commandKeys[number]
        ))) {
        throw new Error('Unexpected writer command field')
    }
}

function requireText(
    value: unknown,
    label: string,
    maximum: number
): string {
    if (typeof value !== 'string') {
        throw new Error(`${label} must be a string`)
    }
    const text = value.trim()
    if (text.length === 0 || text.length > maximum) {
        throw new Error(`${label} must contain 1-${maximum} characters`)
    }
    return text
}

function parseCommand(value: unknown): PromoteCharacterCommand {
    if (!isRecord(value)) throw new Error('Writer command must be an object')
    requireExactKeys(value)
    if (value.schemaVersion !== 1 || value.type !== 'promote-character') {
        throw new Error('Unsupported writer command')
    }
    const commandId = requireText(value.commandId, 'Writer command ID', 128)
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(commandId)) {
        throw new Error('Writer command ID contains unsupported characters')
    }
    if (!Number.isSafeInteger(value.salience)
        || (value.salience as number) < 1
        || (value.salience as number) > 10) {
        throw new Error('Writer salience must be an integer from 1 to 10')
    }
    return {
        schemaVersion: 1,
        type: 'promote-character',
        commandId,
        storyId: requireText(value.storyId, 'Writer story ID', 1_024),
        branchId: requireText(value.branchId, 'Writer branch ID', 1_024),
        sourceNodeId: requireText(
            value.sourceNodeId,
            'Writer source node ID',
            1_024
        ),
        name: requireText(value.name, 'Writer character name', 120),
        summary: requireText(value.summary, 'Writer summary', 2_000),
        salience: value.salience as number,
    }
}

function uniqueEvidence(source: NarrativeNode): EvidenceRef[] {
    const seen = new Set<string>()
    const evidence: EvidenceRef[] = []
    for (const item of source.evidence) {
        const key = JSON.stringify([item.chatId, item.messageId])
        if (seen.has(key)) continue
        seen.add(key)
        evidence.push({ ...item })
    }
    if (evidence.length > 12) {
        throw new Error('Writer source evidence exceeds 12 references')
    }
    return evidence
}

function sameProjectedFact(
    node: NarrativeNode,
    expected: {
        id: string
        title: string
        summary: string
        evidence: EvidenceRef[]
    }
): boolean {
    return node.id === expected.id
        && node.kind === 'claim'
        && node.subtype === 'fact'
        && node.title === expected.title
        && node.summary === expected.summary
        && node.status === 'active'
        && node.authority === 'draft'
        && node.salience === 5
        && node.perspective.kind === 'omniscient'
        && node.epistemic === 'fact'
        && JSON.stringify(node.evidence) === JSON.stringify(expected.evidence)
}

export function compileWriterCommand(
    value: unknown,
    state: NarrativeGraphStateV2
): CompiledWriterCommand {
    const command = parseCommand(structuredClone(value))
    const graph = validateNarrativeGraphState(structuredClone(state))
    if (command.storyId !== graph.storyId
        || command.branchId !== graph.branchId) {
        throw new Error('Writer command is outside graph scope')
    }
    const source = graph.nodes.find((node) =>
        node.id === command.sourceNodeId
    )
    if (!source
        || source.status !== 'active'
        || (source.kind !== 'event' && source.kind !== 'claim')) {
        throw new Error('Writer source must be an active event or claim')
    }
    const evidence = uniqueEvidence(source)
    const prefix = `writer:${command.commandId}`
    const factId = `${prefix}:character-fact`
    const factOperationId = `${prefix}:fact`
    const claimId = `claim:v1:${factId}`
    const entityId = `entity:writer:${command.commandId}`
    const memoryDelta: MemoryDelta = {
        schemaVersion: 1,
        operations: [{
            type: 'add-fact',
            operationId: factOperationId,
            factId,
            text: command.summary,
            evidence: evidence.map((item) => ({ ...item })),
        }],
    }
    const projected = projectMemoryDeltaToNarrativeGraphDelta(
        memoryDelta,
        graph.storyId,
        graph.branchId
    )
    const existingClaim = graph.nodes.find((node) => node.id === claimId)
    if (existingClaim && !sameProjectedFact(existingClaim, {
        id: claimId,
        title: command.summary.slice(0, 80),
        summary: command.summary,
        evidence,
    })) {
        throw new Error('Projected writer fact conflicts with graph state')
    }
    const graphDelta: NarrativeGraphDeltaV2 = {
        schemaVersion: 2,
        storyId: graph.storyId,
        branchId: graph.branchId,
        operations: [
            ...(existingClaim ? [] : projected.operations),
            {
                type: 'add-node',
                operationId: `${prefix}:entity`,
                node: {
                    id: entityId,
                    kind: 'entity',
                    subtype: 'character',
                    title: command.name,
                    summary: command.summary,
                    storyId: graph.storyId,
                    branchId: graph.branchId,
                    status: 'active',
                    authority: 'canonical',
                    salience: command.salience,
                    perspective: { kind: 'omniscient' },
                    epistemic: 'fact',
                    evidence: evidence.map((item) => ({ ...item })),
                },
            },
            {
                type: 'add-edge',
                operationId: `${prefix}:source-relation`,
                edge: {
                    id: `edge:writer:${command.commandId}:source`,
                    sourceId: source.id,
                    type: source.kind === 'event' ? 'involves' : 'about',
                    targetId: entityId,
                    storyId: graph.storyId,
                    branchId: graph.branchId,
                    evidence: evidence.map((item) => ({ ...item })),
                },
            },
            {
                type: 'add-edge',
                operationId: `${prefix}:fact-relation`,
                edge: {
                    id: `edge:writer:${command.commandId}:fact`,
                    sourceId: claimId,
                    type: 'about',
                    targetId: entityId,
                    storyId: graph.storyId,
                    branchId: graph.branchId,
                    evidence: evidence.map((item) => ({ ...item })),
                },
            },
        ],
    }
    const validatedGraphDelta = validateNarrativeGraphDelta(
        graphDelta,
        graph,
        evidence
    )
    return {
        command,
        availableEvidence: evidence.map((item) => ({ ...item })),
        memoryDelta: structuredClone(memoryDelta),
        graphDelta: validatedGraphDelta,
    }
}
