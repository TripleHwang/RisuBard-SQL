import * as nodeFs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
    EvidenceRef,
    MemoryOperation,
    NarrativeEvent,
    NarrativeFact,
    NarrativeMemoryState,
} from '../../packages/risubard-core/src/memoryDelta'

export interface MemoryWorkspace {
    directory: string
    stateFile: string
    eventsFile: string
}

export interface NarrativeMemoryUpdate {
    previousState: NarrativeMemoryState
    state: NarrativeMemoryState
    operations: readonly MemoryOperation[]
}

type MemoryFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'open' | 'readFile' | 'realpath' | 'rename' | 'rm'
>

interface StoredMemory {
    schemaVersion: 1
    state: NarrativeMemoryState
}

interface StoredEvent {
    schemaVersion: 1
    operationId: string
    event: NarrativeEvent
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
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
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
            throw new Error(`Missing ${label} field: ${key}`)
        }
    }
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function requireDenseArray(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`)
    }
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
            throw new Error(`${label} must be a dense array`)
        }
    }
    return value
}

function parseEvidence(value: unknown, label: string): EvidenceRef[] {
    const evidence = requireDenseArray(value, `${label} evidence`)
    if (evidence.length === 0) {
        throw new Error(`${label} must include evidence`)
    }
    return evidence.map((item) => {
        if (!isRecord(item)) throw new Error(`${label} has invalid evidence`)
        assertExactKeys(item, ['chatId', 'messageId'], 'stored evidence')
        return {
            chatId: requireString(item.chatId, 'Stored evidence chatId'),
            messageId: requireString(
                item.messageId,
                'Stored evidence messageId'
            ),
        }
    })
}

function parseFact(value: unknown): NarrativeFact {
    if (!isRecord(value)) throw new Error('Stored fact must be an object')
    const status = value.status
    const keys = status === 'invalidated'
        ? ['id', 'text', 'status', 'evidence', 'invalidatedBy']
        : ['id', 'text', 'status', 'evidence']
    assertExactKeys(value, keys, 'stored fact')
    if (status !== 'active' && status !== 'invalidated') {
        throw new Error('Stored fact has invalid status')
    }
    const fact: NarrativeFact = {
        id: requireString(value.id, 'Stored fact ID'),
        text: requireString(value.text, 'Stored fact text'),
        status,
        evidence: parseEvidence(value.evidence, 'Stored fact'),
    }
    if (status === 'invalidated') {
        fact.invalidatedBy = parseEvidence(
            value.invalidatedBy,
            'Invalidated stored fact'
        )
    }
    return fact
}

function parseEvent(value: unknown): NarrativeEvent {
    if (!isRecord(value)) throw new Error('Stored event must be an object')
    assertExactKeys(value, ['id', 'summary', 'evidence'], 'stored event')
    return {
        id: requireString(value.id, 'Stored event ID'),
        summary: requireString(value.summary, 'Stored event summary'),
        evidence: parseEvidence(value.evidence, 'Stored event'),
    }
}

function parseState(value: unknown): NarrativeMemoryState {
    if (!isRecord(value)) throw new Error('Stored state must be an object')
    assertExactKeys(
        value,
        ['facts', 'events', 'appliedOperationIds'],
        'stored state'
    )
    const facts = requireDenseArray(value.facts, 'Stored state facts')
    const events = requireDenseArray(value.events, 'Stored state events')
    const appliedOperationIds = requireDenseArray(
        value.appliedOperationIds,
        'Stored state appliedOperationIds'
    )
    const state = {
        facts: facts.map(parseFact),
        events: events.map(parseEvent),
        appliedOperationIds: appliedOperationIds.map((operationId) =>
            requireString(operationId, 'Stored operation ID')
        ),
    }
    if (new Set(state.facts.map((fact) => fact.id)).size !== state.facts.length
        || new Set(state.events.map((event) => event.id)).size
            !== state.events.length
        || new Set(state.appliedOperationIds).size
            !== state.appliedOperationIds.length) {
        throw new Error('Stored memory contains duplicate IDs')
    }
    return state
}

function parseStoredMemory(value: unknown): NarrativeMemoryState {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error('Unsupported stored memory schema version')
    }
    assertExactKeys(value, ['schemaVersion', 'state'], 'stored memory')
    return parseState(value.state)
}

function parseStoredEvent(value: unknown): StoredEvent {
    if (!isRecord(value) || value.schemaVersion !== 1) {
        throw new Error('Unsupported stored event schema version')
    }
    assertExactKeys(
        value,
        ['schemaVersion', 'operationId', 'event'],
        'stored event record'
    )
    return {
        schemaVersion: 1,
        operationId: requireString(
            value.operationId,
            'Stored event operation ID'
        ),
        event: parseEvent(value.event),
    }
}

function encodeId(id: string, label: string): string {
    const normalized = requireString(id, label)
    return `id-${Buffer.from(normalized, 'utf8').toString('base64url')}`
}

function confinedPath(root: string, ...segments: string[]): string {
    const target = resolve(root, ...segments)
    const relation = relative(root, target)
    if (relation === '..'
        || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        || resolve(target) === resolve(root)) {
        throw new Error('Memory workspace path escapes its storage root')
    }
    return target
}

export function resolveMemoryWorkspace(
    userDataDirectory: string,
    characterId: string,
    chatId: string
): MemoryWorkspace {
    requireString(userDataDirectory, 'userDataDirectory')
    if (!isAbsolute(userDataDirectory)) {
        throw new Error('userDataDirectory must be absolute')
    }
    const storageRoot = resolve(userDataDirectory, 'risubard')
    const directory = confinedPath(
        storageRoot,
        'characters',
        encodeId(characterId, 'characterId'),
        'chats',
        encodeId(chatId, 'chatId')
    )
    return {
        directory,
        stateFile: confinedPath(directory, 'narrative-state.json'),
        eventsFile: confinedPath(directory, 'events.jsonl'),
    }
}

interface StoredEventLog {
    operationIds: Set<string>
    partialTail: Buffer
}

async function readEventLog(
    fileSystem: MemoryFileSystem,
    eventsFile: string
): Promise<StoredEventLog> {
    let contents: Buffer
    try {
        contents = await fileSystem.readFile(eventsFile)
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { operationIds: new Set(), partialTail: Buffer.alloc(0) }
        }
        throw error
    }
    if (contents.length === 0) {
        return { operationIds: new Set(), partialTail: Buffer.alloc(0) }
    }
    const lastLineFeed = contents.lastIndexOf(0x0a)
    const completeContents = lastLineFeed === -1
        ? Buffer.alloc(0)
        : contents.subarray(0, lastLineFeed)
    const partialTail = contents.subarray(lastLineFeed + 1)
    const lines = completeContents.length === 0
        ? []
        : completeContents.toString('utf8').split('\n')
    return {
        operationIds: new Set(lines.map((line) =>
            parseStoredEvent(JSON.parse(line)).operationId
        )),
        partialTail,
    }
}

function isWithin(root: string, target: string): boolean {
    const relation = relative(root, target)
    return relation === ''
        || (relation !== '..'
            && !relation.startsWith(`..${process.platform === 'win32'
                ? '\\'
                : '/'}`))
}

async function ensureSafeWorkspace(
    fileSystem: MemoryFileSystem,
    userDataDirectory: string,
    workspace: MemoryWorkspace
): Promise<void> {
    await fileSystem.mkdir(userDataDirectory, { recursive: true })
    const realRoot = await fileSystem.realpath(userDataDirectory)
    const relativeDirectory = relative(
        userDataDirectory,
        workspace.directory
    )
    let current = userDataDirectory
    for (const segment of relativeDirectory.split(/[\\/]/)) {
        current = resolve(current, segment)
        try {
            const status = await fileSystem.lstat(current)
            if (status.isSymbolicLink()) {
                throw new Error('Memory workspace contains a symbolic link')
            }
            if (!status.isDirectory()) {
                throw new Error('Memory workspace path is not a directory')
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await fileSystem.mkdir(current)
        }
    }
    const realDirectory = await fileSystem.realpath(workspace.directory)
    if (!isWithin(realRoot, realDirectory)) {
        throw new Error('Memory workspace escapes user data')
    }
}

async function assertSafeFile(
    fileSystem: MemoryFileSystem,
    file: string
): Promise<void> {
    try {
        const status = await fileSystem.lstat(file)
        if (status.isSymbolicLink()) {
            throw new Error('Memory workspace contains a symbolic link')
        }
        if (!status.isFile()) {
            throw new Error('Memory workspace target is not a file')
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
}

async function appendSafely(
    fileSystem: MemoryFileSystem,
    file: string,
    contents: string | Uint8Array
): Promise<void> {
    const noFollow = constants.O_NOFOLLOW ?? 0
    const handle = await fileSystem.open(
        file,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
        0o600
    )
    try {
        await handle.writeFile(contents)
        await handle.sync()
    }
    finally {
        await handle.close()
    }
}

async function writeStateAtomically(
    fileSystem: MemoryFileSystem,
    stateFile: string,
    state: NarrativeMemoryState
): Promise<void> {
    const storedMemory: StoredMemory = {
        schemaVersion: 1,
        state: parseState(state),
    }
    const temporaryFile = `${stateFile}.tmp-${randomUUID()}`
    let handle: Awaited<ReturnType<typeof nodeFs.open>> | undefined
    try {
        handle = await fileSystem.open(temporaryFile, 'wx')
        await handle.writeFile(`${JSON.stringify(storedMemory)}\n`, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await fileSystem.rename(temporaryFile, stateFile)
    }
    catch (error) {
        await handle?.close().catch(() => undefined)
        await fileSystem.rm(temporaryFile, { force: true }).catch(() => undefined)
        throw error
    }
}

export function createMemoryFileAdapter(
    userDataDirectory: string,
    fileSystem: MemoryFileSystem = nodeFs
) {
    requireString(userDataDirectory, 'userDataDirectory')
    if (!isAbsolute(userDataDirectory)) {
        throw new Error('userDataDirectory must be absolute')
    }
    const workspaceFor = (characterId: string, chatId: string) =>
        resolveMemoryWorkspace(userDataDirectory, characterId, chatId)

    return {
        async loadState(
            characterId: string,
            chatId: string
        ): Promise<NarrativeMemoryState> {
            const workspace = workspaceFor(characterId, chatId)
            try {
                const directoryStatus = await fileSystem.lstat(
                    workspace.directory
                )
                if (directoryStatus.isSymbolicLink()) {
                    throw new Error(
                        'Memory workspace contains a symbolic link'
                    )
                }
                if (!directoryStatus.isDirectory()) {
                    throw new Error(
                        'Memory workspace path is not a directory'
                    )
                }
                await ensureSafeWorkspace(
                    fileSystem,
                    userDataDirectory,
                    workspace
                )
                await assertSafeFile(fileSystem, workspace.stateFile)
                const contents = await fileSystem.readFile(
                    workspace.stateFile,
                    'utf8'
                )
                return parseStoredMemory(JSON.parse(contents))
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return {
                        facts: [],
                        events: [],
                        appliedOperationIds: [],
                    }
                }
                throw error
            }
        },

        async persistUpdate(
            characterId: string,
            chatId: string,
            update: NarrativeMemoryUpdate
        ): Promise<void> {
            const workspace = workspaceFor(characterId, chatId)
            const previousOperationIds = new Set(
                parseState(update.previousState).appliedOperationIds
            )
            const state = parseState(update.state)
            const appliedOperationIds = new Set(state.appliedOperationIds)
            const newOperations = update.operations.filter((operation) =>
                !previousOperationIds.has(operation.operationId)
            )
            for (const operation of newOperations) {
                if (!appliedOperationIds.has(operation.operationId)) {
                    throw new Error(
                        `State is missing applied operation: ${operation.operationId}`
                    )
                }
            }

            await ensureSafeWorkspace(
                fileSystem,
                userDataDirectory,
                workspace
            )
            await assertSafeFile(fileSystem, workspace.eventsFile)
            await assertSafeFile(fileSystem, workspace.stateFile)
            const eventLog = await readEventLog(
                fileSystem,
                workspace.eventsFile
            )
            for (const operation of newOperations) {
                if (operation.type !== 'append-event'
                    || eventLog.operationIds.has(operation.operationId)) {
                    continue
                }
                const event = state.events.find((candidate) =>
                    candidate.id === operation.eventId
                )
                if (!event) {
                    throw new Error(
                        `State is missing appended event: ${operation.eventId}`
                    )
                }
                const record: StoredEvent = {
                    schemaVersion: 1,
                    operationId: operation.operationId,
                    event,
                }
                const serializedRecord = Buffer.from(JSON.stringify(record))
                if (eventLog.partialTail.length > 0
                    && !serializedRecord.subarray(
                        0,
                        eventLog.partialTail.length
                    ).equals(eventLog.partialTail)) {
                    throw new Error('Events file has an unrecoverable partial tail')
                }
                const remainder = eventLog.partialTail.length > 0
                    ? serializedRecord.subarray(eventLog.partialTail.length)
                    : serializedRecord
                await appendSafely(
                    fileSystem,
                    workspace.eventsFile,
                    Buffer.concat([remainder, Buffer.from('\n')])
                )
                eventLog.partialTail = Buffer.alloc(0)
                eventLog.operationIds.add(operation.operationId)
            }
            if (eventLog.partialTail.length > 0) {
                throw new Error('Events file has an unrecoverable partial tail')
            }
            await writeStateAtomically(fileSystem, workspace.stateFile, state)
        },
    }
}
