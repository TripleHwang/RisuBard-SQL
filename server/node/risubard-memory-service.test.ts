import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type {
    ApplyNarrativeMemoryDeltaInput,
} from './risubard-memory-service'
import {
    createNarrativeMemoryService,
} from './risubard-memory-service'
import type {
    EvidenceRef,
    MemoryDelta,
    NarrativeMemoryState,
} from '../../packages/risubard-core/src/memoryDelta'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

const temporaryDirectories: string[] = []

async function createUserDataDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(join(tmpdir(), 'risubard-service-'))
    temporaryDirectories.push(directory)
    return directory
}

const availableEvidence: EvidenceRef[] = [{
    chatId: 'chat-1',
    messageId: 'message-1',
}]

const addFactDelta: MemoryDelta = {
    schemaVersion: 1,
    operations: [{
        type: 'add-fact',
        operationId: 'operation-1',
        factId: 'fact-1',
        text: 'The gate is open.',
        evidence: availableEvidence,
    }],
}

const expectedState: NarrativeMemoryState = {
    facts: [{
        id: 'fact-1',
        text: 'The gate is open.',
        status: 'active',
        evidence: availableEvidence,
    }],
    events: [],
    appliedOperationIds: ['operation-1'],
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
    ))
})

describe('narrative memory service', () => {
    test('validates, reduces, and persists a memory delta', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const service = createNarrativeMemoryService(userDataDirectory)

        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addFactDelta,
            availableEvidence,
        })).resolves.toEqual(expectedState)

        await expect(service.loadState(
            'character-1',
            'chat-1'
        )).resolves.toEqual(expectedState)
    })

    test('does not write state or events when validation fails', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        const service = createNarrativeMemoryService(userDataDirectory)

        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: {
                schemaVersion: 1,
                operations: [{
                    ...addFactDelta.operations[0],
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'unknown-message',
                    }],
                }],
            },
            availableEvidence,
        })).rejects.toThrow(
            'Unknown evidence reference: chat-1/unknown-message'
        )

        await expect(fs.stat(workspace.stateFile)).rejects.toMatchObject({
            code: 'ENOENT',
        })
        await expect(fs.stat(workspace.eventsFile)).rejects.toMatchObject({
            code: 'ENOENT',
        })
    })

    test('keeps an applied operation idempotent across service instances', async () => {
        const userDataDirectory = await createUserDataDirectory()
        await createNarrativeMemoryService(userDataDirectory).applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addFactDelta,
            availableEvidence,
        })

        const restartedService = createNarrativeMemoryService(
            userDataDirectory
        )
        await expect(restartedService.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addFactDelta,
            availableEvidence,
        })).resolves.toEqual(expectedState)
    })

    test('serializes simultaneous updates for the same character and chat', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const firstService = createNarrativeMemoryService(userDataDirectory)
        const secondService = createNarrativeMemoryService(userDataDirectory)
        const secondDelta: MemoryDelta = {
            schemaVersion: 1,
            operations: [{
                type: 'add-fact',
                operationId: 'operation-2',
                factId: 'fact-2',
                text: 'The lantern is lit.',
                evidence: availableEvidence,
            }],
        }

        await Promise.all([
            firstService.applyDelta({
                characterId: 'character-1',
                chatId: 'chat-1',
                delta: addFactDelta,
                availableEvidence,
            }),
            secondService.applyDelta({
                characterId: 'character-1',
                chatId: 'chat-1',
                delta: secondDelta,
                availableEvidence,
            }),
        ])

        await expect(firstService.loadState(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            facts: [
                { id: 'fact-1' },
                { id: 'fact-2' },
            ],
            appliedOperationIds: ['operation-1', 'operation-2'],
        })
    })

    test('continues queued updates after a rejected delta', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const service = createNarrativeMemoryService(userDataDirectory)
        const invalid = service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: {
                schemaVersion: 1,
                operations: [{
                    ...addFactDelta.operations[0],
                    evidence: [{
                        chatId: 'chat-1',
                        messageId: 'unknown-message',
                    }],
                }],
            },
            availableEvidence,
        })
        const valid = service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addFactDelta,
            availableEvidence,
        })

        await expect(invalid).rejects.toThrow('Unknown evidence reference')
        await expect(valid).resolves.toEqual(expectedState)
    })

    test('uses an invocation-time snapshot of queued input', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const service = createNarrativeMemoryService(userDataDirectory)
        const secondDelta: MemoryDelta = {
            schemaVersion: 1,
            operations: [{
                type: 'add-fact',
                operationId: 'operation-2',
                factId: 'fact-2',
                text: 'The lantern is lit.',
                evidence: availableEvidence,
            }],
        }
        const queuedInput: ApplyNarrativeMemoryDeltaInput = {
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: secondDelta,
            availableEvidence,
        }

        const first = service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addFactDelta,
            availableEvidence,
        })
        const queued = service.applyDelta(queuedInput)
        queuedInput.characterId = 'character-2'
        queuedInput.chatId = 'chat-2'
        queuedInput.delta = {
            schemaVersion: 1,
            operations: [{
                type: 'add-fact',
                operationId: 'operation-mutated',
                factId: 'fact-mutated',
                text: 'Mutated after invocation.',
                evidence: [{
                    chatId: 'chat-2',
                    messageId: 'message-2',
                }],
            }],
        }
        queuedInput.availableEvidence = [{
            chatId: 'chat-2',
            messageId: 'message-2',
        }]

        await Promise.all([first, queued])

        await expect(service.loadState(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            facts: [
                { id: 'fact-1' },
                { id: 'fact-2' },
            ],
        })
        await expect(service.loadState(
            'character-2',
            'chat-2'
        )).resolves.toMatchObject({
            facts: [],
            appliedOperationIds: [],
        })
    })

    test('rejects an uncloneable candidate without throwing synchronously', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const service = createNarrativeMemoryService(userDataDirectory)
        let rejected: Promise<NarrativeMemoryState> | undefined

        expect(() => {
            rejected = service.applyDelta({
                characterId: 'character-1',
                chatId: 'chat-1',
                delta: {
                    schemaVersion: 1,
                    operations: [() => undefined],
                },
                availableEvidence,
            })
        }).not.toThrow()
        await expect(rejected).rejects.toMatchObject({
            name: 'DataCloneError',
        })

        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addFactDelta,
            availableEvidence,
        })).resolves.toEqual(expectedState)
    })
})
