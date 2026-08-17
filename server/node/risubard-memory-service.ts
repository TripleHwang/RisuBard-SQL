import {
    applyMemoryDelta,
    type EvidenceRef,
    type NarrativeMemoryState,
    validateMemoryDelta,
} from '../../packages/risubard-core/src/memoryDelta'
import {
    createMemoryFileAdapter,
    resolveMemoryWorkspace,
} from './risubard-memory-workspace'

export interface ApplyNarrativeMemoryDeltaInput {
    characterId: string
    chatId: string
    delta: unknown
    availableEvidence: readonly EvidenceRef[]
}

const workspaceTails = new Map<string, Promise<void>>()

function enqueueWorkspaceTask<T>(
    workspaceKey: string,
    task: () => Promise<T>
): Promise<T> {
    const previousTail = workspaceTails.get(workspaceKey) ?? Promise.resolve()
    const result = previousTail.then(task, task)
    const currentTail = result.then(
        () => undefined,
        () => undefined
    )
    workspaceTails.set(workspaceKey, currentTail)
    void currentTail.finally(() => {
        if (workspaceTails.get(workspaceKey) === currentTail) {
            workspaceTails.delete(workspaceKey)
        }
    })
    return result
}

export function createNarrativeMemoryService(userDataDirectory: string) {
    const adapter = createMemoryFileAdapter(userDataDirectory)
    const workspaceKey = (characterId: string, chatId: string) =>
        resolveMemoryWorkspace(
            userDataDirectory,
            characterId,
            chatId
        ).directory

    return {
        loadState(
            characterId: string,
            chatId: string
        ): Promise<NarrativeMemoryState> {
            return enqueueWorkspaceTask(
                workspaceKey(characterId, chatId),
                () => adapter.loadState(characterId, chatId)
            )
        },

        applyDelta(
            input: ApplyNarrativeMemoryDeltaInput
        ): Promise<NarrativeMemoryState> {
            let characterId: string
            let chatId: string
            let delta: unknown
            let availableEvidence: EvidenceRef[]
            try {
                characterId = input.characterId
                chatId = input.chatId
                delta = structuredClone(input.delta)
                availableEvidence = Array.from(
                    input.availableEvidence,
                    (evidence) => ({ ...evidence })
                )
            }
            catch (error) {
                return Promise.reject(error)
            }
            return enqueueWorkspaceTask(
                workspaceKey(characterId, chatId),
                async () => {
                    const previousState = await adapter.loadState(
                        characterId,
                        chatId
                    )
                    const parsedDelta = validateMemoryDelta(
                        delta,
                        previousState,
                        availableEvidence
                    )
                    const state = applyMemoryDelta(
                        previousState,
                        parsedDelta,
                        availableEvidence
                    )
                    await adapter.persistUpdate(
                        characterId,
                        chatId,
                        {
                            previousState,
                            state,
                            operations: parsedDelta.operations,
                        }
                    )
                    return state
                }
            )
        },
    }
}
