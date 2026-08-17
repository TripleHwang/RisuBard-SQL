import {
    applyNarrativeGraphDelta,
    createV1ReconciliationDelta,
    validateNarrativeGraphDelta,
} from '../../packages/risubard-core/src/narrativeDelta'
import type {
    NarrativeGraphStateV2,
} from '../../packages/risubard-core/src/narrativeGraph'
import {
    adaptV1NarrativeMemory,
} from '../../packages/risubard-core/src/narrativeGraph'
import {
    buildNarrativeIndex,
    normalizeNarrativeTerms,
    updateNarrativeIndex,
    type NarrativeGraphIndex,
} from '../../packages/risubard-core/src/narrativeIndex'
import {
    inquireNarrativeMemory,
    narrativeInquiryToContextSources,
    type NarrativeInquiryMetrics,
} from '../../packages/risubard-core/src/narrativeInquiry'
import type {
    EvidenceRef,
    MemoryDelta,
    NarrativeMemoryState,
} from '../../packages/risubard-core/src/memoryDelta'
import {
    compileWriterCommand,
} from '../../packages/risubard-core/src/writerCommand'
import {
    createNarrativeGraphFileAdapter,
    resolveNarrativeGraphWorkspace,
} from './risubard-graph-workspace'

export interface ApplyNarrativeGraphDeltaInput {
    characterId: string
    chatId: string
    delta: unknown
    availableEvidence: readonly EvidenceRef[]
}

export interface ApplyWriterCommandInput {
    characterId: string
    chatId: string
    expectedRevision: number
    command: unknown
}

export interface NarrativeInquiryRequest {
    characterId: string
    chatId: string
    currentInput: string
}

interface NarrativeGraphServiceOptions {
    loadV1State(
        characterId: string,
        chatId: string
    ): Promise<NarrativeMemoryState>
    applyV1Delta?(input: {
        characterId: string
        chatId: string
        delta: MemoryDelta
        availableEvidence: readonly EvidenceRef[]
    }): Promise<NarrativeMemoryState>
    adapter?: ReturnType<typeof createNarrativeGraphFileAdapter>
}

interface NarrativeSessionObservability {
    lastInquiry: NarrativeInquiryMetrics | null
    lastPromptMode: 'disabled'
        | 'v2-current'
        | 'bounded-v1-fallback'
    graphRevision: number
    indexRevision: number
    cacheStatus: 'disabled' | 'current' | 'missing-or-stale'
    lastAnalysis: {
        status: 'success' | 'failed'
        appliedCount: number
    } | null
}

const workspaceTails = new Map<string, Promise<void>>()
const workspacePublishedRevisions = new Map<string, number>()

function enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = workspaceTails.get(key) ?? Promise.resolve()
    const result = previous.then(task, task)
    const tail = result.then(() => undefined, () => undefined)
    workspaceTails.set(key, tail)
    void tail.finally(() => {
        if (workspaceTails.get(key) === tail) workspaceTails.delete(key)
    })
    return result
}

export function createNarrativeGraphService(
    userDataDirectory: string,
    options: NarrativeGraphServiceOptions
) {
    const adapter = options.adapter
        ?? createNarrativeGraphFileAdapter(userDataDirectory)
    const cached = new Map<string, {
        state: NarrativeGraphStateV2
        index: NarrativeGraphIndex
    }>()
    const dirty = new Set<string>()
    const hydrationAttempted = new Set<string>()
    const observations = new Map<string, NarrativeSessionObservability>()
    let lastObservedKey: string | null = null
    const keyFor = (characterId: string, chatId: string) =>
        resolveNarrativeGraphWorkspace(
            userDataDirectory,
            characterId,
            chatId
        ).directory
    const observationFor = (key: string): NarrativeSessionObservability => {
        const current = observations.get(key)
        if (current) return current
        const created: NarrativeSessionObservability = {
            lastInquiry: null,
            lastPromptMode: 'disabled',
            graphRevision: 0,
            indexRevision: 0,
            cacheStatus: 'disabled',
            lastAnalysis: null,
        }
        observations.set(key, created)
        return created
    }
    const currentCache = (key: string) => {
        const current = cached.get(key)
        const publishedRevision = workspacePublishedRevisions.get(key)
        if (current && publishedRevision !== undefined
            && current.state.revision !== publishedRevision) {
            cached.delete(key)
            hydrationAttempted.delete(key)
            return undefined
        }
        return current
    }
    const publishRevision = (key: string, revision: number): void => {
        workspacePublishedRevisions.set(key, revision)
    }

    return {
        loadState(characterId: string, chatId: string) {
            return enqueue(
                keyFor(characterId, chatId),
                () => adapter.loadState(characterId, chatId)
            )
        },

        applyDelta(
            input: ApplyNarrativeGraphDeltaInput
        ): Promise<NarrativeGraphStateV2> {
            let snapshot: ApplyNarrativeGraphDeltaInput
            try {
                snapshot = {
                    characterId: input.characterId,
                    chatId: input.chatId,
                    delta: structuredClone(input.delta),
                    availableEvidence: Array.from(
                        input.availableEvidence,
                        (item) => ({ ...item })
                    ),
                }
            }
            catch (error) {
                return Promise.reject(error)
            }
            const key = keyFor(snapshot.characterId, snapshot.chatId)
            return enqueue(key, async () => {
                let persistenceStarted = false
                try {
                    const wasDirty = dirty.has(key)
                        || await adapter.isIndexDirty(
                            snapshot.characterId,
                            snapshot.chatId
                        ).catch(() => true)
                    const current = wasDirty
                        ? undefined
                        : currentCache(key)
                    const previousState = current?.state
                        ?? await adapter.loadState(
                            snapshot.characterId,
                            snapshot.chatId
                        )
                    const delta = validateNarrativeGraphDelta(
                        snapshot.delta,
                        previousState,
                        snapshot.availableEvidence
                    )
                    const alreadyApplied = new Set(
                        previousState.appliedOperationIds
                    )
                    const appliedCount = delta.operations.filter(
                        (operation) =>
                            !alreadyApplied.has(operation.operationId)
                    ).length
                    const state = applyNarrativeGraphDelta(
                        previousState,
                        delta,
                        snapshot.availableEvidence
                    )
                    const index = current && !wasDirty
                        ? updateNarrativeIndex(
                            current.index,
                            previousState,
                            state,
                            delta.operations
                        )
                        : buildNarrativeIndex(state)
                    persistenceStarted = true
                    await adapter.persistUpdate(
                        snapshot.characterId,
                        snapshot.chatId,
                        {
                            previousState,
                            state,
                            operations: delta.operations,
                            index,
                        }
                    )
                    publishRevision(key, state.revision)
                    if (wasDirty) {
                        dirty.add(key)
                        cached.delete(key)
                        await adapter.invalidateIndexArtifact(
                            snapshot.characterId,
                            snapshot.chatId
                        )
                    }
                    else {
                        cached.set(key, { state, index })
                    }
                    observationFor(key).lastAnalysis = {
                        status: 'success',
                        appliedCount,
                    }
                    lastObservedKey = key
                    return state
                }
                catch (error) {
                    observationFor(key).lastAnalysis = {
                        status: 'failed',
                        appliedCount: 0,
                    }
                    lastObservedKey = key
                    if (!persistenceStarted) throw error
                    dirty.add(key)
                    cached.delete(key)
                    try {
                        await adapter.markIndexDirty(
                            snapshot.characterId,
                            snapshot.chatId
                        )
                    }
                    catch {
                        // Index deletion is an independent fallback signal.
                    }
                    try {
                        await adapter.invalidateIndexArtifact(
                            snapshot.characterId,
                            snapshot.chatId
                        )
                    }
                    catch {
                        // An unreadable artifact also forces inquiry fallback.
                    }
                    throw error
                }
            })
        },

        applyWriterCommand(
            input: ApplyWriterCommandInput
        ): Promise<{ revision: number }> {
            let snapshot: ApplyWriterCommandInput
            try {
                snapshot = {
                    characterId: input.characterId,
                    chatId: input.chatId,
                    expectedRevision: input.expectedRevision,
                    command: structuredClone(input.command),
                }
            }
            catch (error) {
                return Promise.reject(error)
            }
            const key = keyFor(snapshot.characterId, snapshot.chatId)
            return enqueue(key, async () => {
                const unavailable = dirty.has(key)
                    || await adapter.isIndexDirty(
                        snapshot.characterId,
                        snapshot.chatId
                    ).catch(() => true)
                if (unavailable) {
                    throw new Error('Writer graph is unavailable')
                }
                const current = currentCache(key)
                const previousState = current?.state
                    ?? await adapter.loadState(
                        snapshot.characterId,
                        snapshot.chatId
                    )
                if (!Number.isSafeInteger(snapshot.expectedRevision)
                    || snapshot.expectedRevision !== previousState.revision) {
                    throw new Error('Writer graph revision is stale')
                }
                const compiled = compileWriterCommand(
                    snapshot.command,
                    previousState
                )
                if (!options.applyV1Delta) {
                    throw new Error('Writer v1 persistence is unavailable')
                }
                await options.applyV1Delta({
                    characterId: snapshot.characterId,
                    chatId: snapshot.chatId,
                    delta: compiled.memoryDelta,
                    availableEvidence: compiled.availableEvidence,
                })
                try {
                    const delta = validateNarrativeGraphDelta(
                        compiled.graphDelta,
                        previousState,
                        compiled.availableEvidence
                    )
                    const state = applyNarrativeGraphDelta(
                        previousState,
                        delta,
                        compiled.availableEvidence
                    )
                    const index = current
                        ? updateNarrativeIndex(
                            current.index,
                            previousState,
                            state,
                            delta.operations
                        )
                        : buildNarrativeIndex(state)
                    await adapter.persistUpdate(
                        snapshot.characterId,
                        snapshot.chatId,
                        {
                            previousState,
                            state,
                            operations: delta.operations,
                            index,
                        }
                    )
                    publishRevision(key, state.revision)
                    cached.set(key, { state, index })
                    return { revision: state.revision }
                }
                catch (error) {
                    dirty.add(key)
                    cached.delete(key)
                    try {
                        await adapter.markIndexDirty(
                            snapshot.characterId,
                            snapshot.chatId
                        )
                    }
                    catch {
                        // Index deletion is an independent fallback signal.
                    }
                    try {
                        await adapter.invalidateIndexArtifact(
                            snapshot.characterId,
                            snapshot.chatId
                        )
                    }
                    catch {
                        // An unreadable artifact also forces inquiry fallback.
                    }
                    throw new Error(
                        'Writer graph persistence failed',
                        { cause: error }
                    )
                }
            })
        },

        reconcileV1(
            characterId: string,
            chatId: string
        ): Promise<NarrativeGraphStateV2> {
            const key = keyFor(characterId, chatId)
            return enqueue(key, async () => {
                try {
                    const [memoryState, previousState] = await Promise.all([
                        options.loadV1State(characterId, chatId),
                        adapter.loadState(characterId, chatId),
                    ])
                    const delta = createV1ReconciliationDelta(
                        memoryState,
                        previousState
                    )
                    const availableEvidence = [
                        ...memoryState.facts.flatMap((fact) => [
                            ...fact.evidence,
                            ...(fact.invalidatedBy ?? []),
                        ]),
                        ...memoryState.events.flatMap(
                            (event) => event.evidence
                        ),
                    ].map((item) => ({ ...item }))
                    const validated = validateNarrativeGraphDelta(
                        delta,
                        previousState,
                        availableEvidence
                    )
                    const state = applyNarrativeGraphDelta(
                        previousState,
                        validated,
                        availableEvidence
                    )
                    const index = buildNarrativeIndex(state)
                    await adapter.persistUpdate(
                        characterId,
                        chatId,
                        {
                            previousState,
                            state,
                            operations: validated.operations,
                            index,
                        }
                    )
                    publishRevision(key, state.revision)
                    await adapter.clearIndexDirty(characterId, chatId)
                    dirty.delete(key)
                    if (state.revision === 0) {
                        cached.delete(key)
                        await adapter.invalidateIndexArtifact(
                            characterId,
                            chatId
                        )
                    }
                    else {
                        cached.set(key, { state, index })
                    }
                    return state
                }
                catch (error) {
                    dirty.add(key)
                    cached.delete(key)
                    try {
                        await adapter.markIndexDirty(characterId, chatId)
                    }
                    catch {
                        // Index deletion is an independent fallback signal.
                    }
                    try {
                        await adapter.invalidateIndexArtifact(
                            characterId,
                            chatId
                        )
                    }
                    catch {
                        // An unreadable artifact also forces inquiry fallback.
                    }
                    throw error
                }
            })
        },

        async hydrateIndex(
            characterId: string,
            chatId: string
        ): Promise<boolean> {
            const key = keyFor(characterId, chatId)
            return enqueue(key, async () => {
                cached.delete(key)
                if (dirty.has(key)
                    || await adapter.isIndexDirty(
                        characterId,
                        chatId
                    ).catch(() => true)) {
                    dirty.add(key)
                    return false
                }
                const state = await adapter.loadState(characterId, chatId)
                if (state.revision === 0) {
                    workspacePublishedRevisions.delete(key)
                    return false
                }
                try {
                    const stored = await adapter.loadIndexArtifact(
                        characterId,
                        chatId
                    )
                    const rebuilt = buildNarrativeIndex(state)
                    if (JSON.stringify(stored) !== JSON.stringify(rebuilt)) {
                        return false
                    }
                    cached.set(key, { state, index: rebuilt })
                    publishRevision(key, state.revision)
                    return true
                }
                catch {
                    return false
                }
            })
        },

        async readForInquiry(characterId: string, chatId: string) {
            const current = currentCache(keyFor(characterId, chatId))
            if (current
                && current.index.revision === current.state.revision) {
                return {
                    mode: 'v2' as const,
                    state: current.state,
                    index: current.index,
                }
            }
            return {
                mode: 'v1' as const,
                reason: 'missing-or-stale-v2-index' as const,
                state: await options.loadV1State(characterId, chatId),
            }
        },

        async inquire(input: NarrativeInquiryRequest) {
            const snapshot = structuredClone(input)
            if (typeof snapshot.currentInput !== 'string'
                || snapshot.currentInput.trim().length === 0
                || snapshot.currentInput.length > 4_096) {
                throw new Error('Invalid narrative inquiry request')
            }
            let current = await this.readForInquiry(
                snapshot.characterId,
                snapshot.chatId
            )
            const inquiryKey = keyFor(
                snapshot.characterId,
                snapshot.chatId
            )
            if (current.mode === 'v1'
                && !hydrationAttempted.has(inquiryKey)) {
                hydrationAttempted.add(inquiryKey)
                const hydrated = await this.hydrateIndex(
                    snapshot.characterId,
                    snapshot.chatId
                ).catch(() => false)
                if (hydrated) {
                    current = await this.readForInquiry(
                        snapshot.characterId,
                        snapshot.chatId
                    )
                }
            }
            const index = current.mode === 'v2'
                ? current.index
                : buildNarrativeIndex(adaptV1NarrativeMemory({
                    state: {
                        facts: current.state.facts.slice(-32),
                        events: current.state.events.slice(-32),
                        appliedOperationIds: [],
                    },
                    storyId: snapshot.characterId,
                    branchId: snapshot.chatId,
                }))
            const result = inquireNarrativeMemory(index, {
                entityIds: [snapshot.characterId],
                openThreadIds: [],
                terms: normalizeNarrativeTerms(
                    snapshot.currentInput
                ).slice(0, 32),
                perspectiveEntityIds: [snapshot.characterId],
                tokenBudget: 512,
                maxSelectedNodes: 16,
                postingLimit: 16,
                directCandidateLimit: 32,
                candidateLimit: 64,
                edgeLimitPerNode: 16,
                hopLimit: 1,
            })
            const terms = normalizeNarrativeTerms(
                snapshot.currentInput
            ).slice(0, 32)
            const entityCandidates = [...new Set(
                terms.flatMap((term) => index.postingsByTerm[term] ?? [])
            )].map((nodeId) => index.nodeById[nodeId])
                .filter((node) => node?.kind === 'entity')
                .slice(0, 16)
                .map((node) => ({ id: node.id, title: node.title }))
            const observation = observationFor(inquiryKey)
            observation.lastInquiry = structuredClone(result.metrics)
            observation.lastPromptMode = current.mode === 'v2'
                ? 'v2-current'
                : 'bounded-v1-fallback'
            observation.graphRevision = current.mode === 'v2'
                ? current.state.revision
                : 0
            observation.indexRevision = current.mode === 'v2'
                ? current.index.revision
                : 0
            observation.cacheStatus = current.mode === 'v2'
                ? 'current'
                : 'missing-or-stale'
            lastObservedKey = inquiryKey
            return {
                mode: current.mode === 'v2'
                    ? 'v2-current' as const
                    : 'bounded-v1-fallback' as const,
                graphRevision: current.mode === 'v2'
                    ? current.state.revision
                    : 0,
                indexRevision: current.mode === 'v2'
                    ? current.index.revision
                    : 0,
                cacheStatus: current.mode === 'v2'
                    ? 'current' as const
                    : 'missing-or-stale' as const,
                sources: narrativeInquiryToContextSources(result),
                entityCandidates,
                metrics: structuredClone(result.metrics),
            }
        },

        recordAnalysis(
            characterId: string,
            chatId: string,
            result: {
                status: 'success' | 'failed'
                appliedCount: number
            }
        ) {
            if ((result.status !== 'success' && result.status !== 'failed')
                || !Number.isSafeInteger(result.appliedCount)
                || result.appliedCount < 0) {
                throw new Error('Invalid narrative analysis observation')
            }
            const key = keyFor(characterId, chatId)
            observationFor(key).lastAnalysis = {
                status: result.status,
                appliedCount: result.appliedCount,
            }
            lastObservedKey = key
        },

        metrics(characterId?: string, chatId?: string) {
            const requestedKey = characterId !== undefined
                && chatId !== undefined
                ? keyFor(characterId, chatId)
                : lastObservedKey
            const observation = requestedKey
                ? observations.get(requestedKey)
                : undefined
            return {
                requestGraphNodeInspections:
                    observation?.lastInquiry?.inspectedNodeCount ?? 0,
                requestIndexBuilds:
                    observation?.lastPromptMode === 'bounded-v1-fallback'
                        ? 1
                        : 0,
                lastPromptMode: observation?.lastPromptMode ?? 'disabled',
                graphRevision: observation?.graphRevision ?? 0,
                indexRevision: observation?.indexRevision ?? 0,
                cacheStatus: observation?.cacheStatus ?? 'disabled',
                lastInquiry: observation?.lastInquiry
                    ? structuredClone(observation.lastInquiry)
                    : null,
                lastAnalysis: observation?.lastAnalysis
                    ? structuredClone(observation.lastAnalysis)
                    : null,
            }
        },
    }
}
