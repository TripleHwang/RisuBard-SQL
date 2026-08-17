import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type {
    AppendEventOperation,
    NarrativeMemoryState,
} from '../../packages/risubard-core/src/memoryDelta'
import {
    createMemoryFileAdapter,
    resolveMemoryWorkspace,
} from './risubard-memory-workspace'

const temporaryDirectories: string[] = []

async function createUserDataDirectory(): Promise<string> {
    const directory = await fs.mkdtemp(join(tmpdir(), 'risubard-memory-'))
    temporaryDirectories.push(directory)
    return directory
}

function emptyState(): NarrativeMemoryState {
    return {
        facts: [],
        events: [],
        appliedOperationIds: [],
    }
}

const appendEvent: AppendEventOperation = {
    type: 'append-event',
    operationId: 'operation-1',
    eventId: 'event-1',
    summary: 'The gate opened.',
    evidence: [{
        chatId: 'chat-1',
        messageId: 'message-1',
    }],
}

const stateWithEvent: NarrativeMemoryState = {
    facts: [],
    events: [{
        id: 'event-1',
        summary: 'The gate opened.',
        evidence: [{
            chatId: 'chat-1',
            messageId: 'message-1',
        }],
    }],
    appliedOperationIds: ['operation-1'],
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
    ))
})

describe('resolveMemoryWorkspace', () => {
    test('encodes IDs as safe path segments confined to user data', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            '../../character\\escape',
            'chat/../../../escape'
        )
        const storageRoot = resolve(userDataDirectory, 'risubard')

        expect(relative(storageRoot, workspace.directory)).not.toMatch(
            /^(?:\.\.(?:[\\/]|$)|[\\/])/
        )
        expect(workspace.directory).not.toContain('..')
        expect(workspace.directory).not.toContain('character\\escape')
        expect(workspace.directory).not.toContain('chat/')
    })

    test.each(['', '   '])('rejects an empty ID: %j', async (id) => {
        const userDataDirectory = await createUserDataDirectory()

        expect(() =>
            resolveMemoryWorkspace(userDataDirectory, id, 'chat-1')
        ).toThrow('characterId must not be empty')
        expect(() =>
            resolveMemoryWorkspace(userDataDirectory, 'character-1', id)
        ).toThrow('chatId must not be empty')
    })
})

describe('memory file adapter', () => {
    test('round-trips a validated narrative state', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        const adapter = createMemoryFileAdapter(userDataDirectory)

        await adapter.persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state: stateWithEvent,
            operations: [appendEvent],
        })

        await expect(adapter.loadState('character-1', 'chat-1')).resolves.toEqual(
            stateWithEvent
        )
    })

    test('rejects malformed or extended stored state', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        await fs.mkdir(workspace.directory, { recursive: true })
        await fs.writeFile(workspace.stateFile, JSON.stringify({
            schemaVersion: 1,
            state: emptyState(),
            rawPath: '../outside',
        }))

        await expect(
            createMemoryFileAdapter(userDataDirectory).loadState(
                'character-1',
                'chat-1'
            )
        ).rejects.toThrow('Unexpected stored memory field: rawPath')
    })

    test('appends event records without rewriting existing records', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        const adapter = createMemoryFileAdapter(userDataDirectory)
        await fs.mkdir(workspace.directory, { recursive: true })
        const existingRecord = JSON.stringify({
            schemaVersion: 1,
            operationId: 'operation-existing',
            event: {
                id: 'event-existing',
                summary: 'Existing event.',
                evidence: [{
                    chatId: 'chat-1',
                    messageId: 'message-existing',
                }],
            },
        })
        await fs.writeFile(workspace.eventsFile, `${existingRecord}\n`)

        await adapter.persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state: stateWithEvent,
            operations: [appendEvent],
        })

        const contents = await fs.readFile(workspace.eventsFile, 'utf8')
        expect(contents.startsWith(`${existingRecord}\n`)).toBe(true)
        expect(contents.trim().split('\n')).toHaveLength(2)
    })

    test('does not append an event operation again after an interrupted retry', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        const adapter = createMemoryFileAdapter(userDataDirectory)
        await adapter.persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state: stateWithEvent,
            operations: [appendEvent],
        })
        await fs.writeFile(workspace.stateFile, JSON.stringify({
            schemaVersion: 1,
            state: emptyState(),
        }))

        await adapter.persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state: stateWithEvent,
            operations: [appendEvent],
        })

        const records = (await fs.readFile(workspace.eventsFile, 'utf8'))
            .trim()
            .split('\n')
        expect(records).toHaveLength(1)
        await expect(adapter.loadState('character-1', 'chat-1')).resolves.toEqual(
            stateWithEvent
        )
    })

    test('preserves the previous state when atomic rename fails', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        const adapter = createMemoryFileAdapter(userDataDirectory)
        await adapter.persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state: emptyState(),
            operations: [],
        })
        const failingAdapter = createMemoryFileAdapter(userDataDirectory, {
            ...fs,
            rename: async () => {
                throw new Error('simulated rename failure')
            },
        })

        await expect(failingAdapter.persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state: stateWithEvent,
            operations: [appendEvent],
        })).rejects.toThrow('simulated rename failure')

        await expect(adapter.loadState(
            'character-1',
            'chat-1'
        )).resolves.toEqual(emptyState())
        const files = await fs.readdir(workspace.directory)
        expect(files.filter((file) => file.includes('.tmp-'))).toEqual([])
    })

    test('does not accept caller-controlled workspace paths for I/O', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const outsideFile = join(
            await createUserDataDirectory(),
            'outside-state.json'
        )
        const adapter = createMemoryFileAdapter(userDataDirectory)

        await expect(adapter.loadState({
            directory: dirname(outsideFile),
            stateFile: outsideFile,
            eventsFile: `${outsideFile}.events`,
        } as unknown as string, 'chat-1')).rejects.toThrow(
            'characterId must not be empty'
        )
        await expect(fs.stat(outsideFile)).rejects.toMatchObject({
            code: 'ENOENT',
        })
    })

    test('completes a truncated matching event tail on retry', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        const adapter = createMemoryFileAdapter(userDataDirectory)
        await fs.mkdir(workspace.directory, { recursive: true })
        const fullRecord = `${JSON.stringify({
            schemaVersion: 1,
            operationId: appendEvent.operationId,
            event: stateWithEvent.events[0],
        })}\n`
        await fs.writeFile(
            workspace.eventsFile,
            fullRecord.slice(0, Math.floor(fullRecord.length / 2))
        )

        await adapter.persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state: stateWithEvent,
            operations: [appendEvent],
        })

        expect(await fs.readFile(workspace.eventsFile, 'utf8')).toBe(fullRecord)
        await expect(adapter.loadState(
            'character-1',
            'chat-1'
        )).resolves.toEqual(stateWithEvent)
    })

    test('recovers when an event append stops inside a UTF-8 character', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        const adapter = createMemoryFileAdapter(userDataDirectory)
        const operation: AppendEventOperation = {
            ...appendEvent,
            summary: '문이 열렸다.',
        }
        const state: NarrativeMemoryState = {
            ...stateWithEvent,
            events: [{
                ...stateWithEvent.events[0],
                summary: operation.summary,
            }],
        }
        const fullRecord = Buffer.from(`${JSON.stringify({
            schemaVersion: 1,
            operationId: operation.operationId,
            event: state.events[0],
        })}\n`)
        const koreanBytes = Buffer.from('문')
        const splitAt = fullRecord.indexOf(koreanBytes) + 1
        await fs.mkdir(workspace.directory, { recursive: true })
        await fs.writeFile(workspace.eventsFile, fullRecord.subarray(0, splitAt))

        await adapter.persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state,
            operations: [operation],
        })

        expect(await fs.readFile(workspace.eventsFile)).toEqual(fullRecord)
    })

    test.each(['facts', 'events', 'appliedOperationIds'] as const)(
        'rejects sparse %s before writing state',
        async (field) => {
            const userDataDirectory = await createUserDataDirectory()
            const adapter = createMemoryFileAdapter(userDataDirectory)
            const state = emptyState()
            state[field] = new Array(1) as never

            await expect(adapter.persistUpdate(
                'character-1',
                'chat-1',
                {
                    previousState: emptyState(),
                    state,
                    operations: [],
                }
            )).rejects.toThrow(`Stored state ${field} must be a dense array`)
        }
    )

    test('rejects a symlinked character directory that escapes user data', async () => {
        const userDataDirectory = await createUserDataDirectory()
        const outsideDirectory = await createUserDataDirectory()
        const workspace = resolveMemoryWorkspace(
            userDataDirectory,
            'character-1',
            'chat-1'
        )
        const characterDirectory = dirname(dirname(workspace.directory))
        await fs.mkdir(dirname(characterDirectory), { recursive: true })
        await fs.symlink(outsideDirectory, characterDirectory, 'junction')

        await expect(createMemoryFileAdapter(
            userDataDirectory
        ).persistUpdate('character-1', 'chat-1', {
            previousState: emptyState(),
            state: emptyState(),
            operations: [],
        })).rejects.toThrow('Memory workspace contains a symbolic link')

        await expect(fs.stat(join(
            outsideDirectory,
            'chats'
        ))).rejects.toMatchObject({ code: 'ENOENT' })
    })
})
