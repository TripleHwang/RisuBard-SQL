import * as nodeFs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type {
    NarrativeGraphOperation,
} from '../../packages/risubard-core/src/narrativeDelta'
import {
    applyNarrativeGraphDelta,
} from '../../packages/risubard-core/src/narrativeDelta'
import {
    validateNarrativeGraphState,
    type NarrativeGraphStateV2,
} from '../../packages/risubard-core/src/narrativeGraph'
import type {
    NarrativeGraphIndex,
} from '../../packages/risubard-core/src/narrativeIndex'
import type { EvidenceRef } from '../../packages/risubard-core/src/memoryDelta'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

export interface NarrativeGraphWorkspace {
    directory: string
    stateFile: string
    operationsFile: string
    indexFile: string
    dirtyFile: string
}

export interface NarrativeGraphUpdate {
    previousState: NarrativeGraphStateV2
    state: NarrativeGraphStateV2
    operations: readonly NarrativeGraphOperation[]
    index: NarrativeGraphIndex
}

type GraphFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'open' | 'readFile' | 'realpath' | 'rename' | 'rm'
>

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertExactKeys(
    value: Record<string, unknown>,
    keys: readonly string[],
    label: string
): void {
    const actual = Object.keys(value)
    if (actual.length !== keys.length
        || actual.some((key) => !keys.includes(key))) {
        throw new Error(`Invalid ${label} fields`)
    }
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

export function resolveNarrativeGraphWorkspace(
    userDataDirectory: string,
    characterId: string,
    chatId: string
): NarrativeGraphWorkspace {
    const memory = resolveMemoryWorkspace(
        userDataDirectory,
        characterId,
        chatId
    )
    return {
        directory: memory.directory,
        stateFile: resolve(memory.directory, 'narrative-graph-state.json'),
        operationsFile: resolve(
            memory.directory,
            'narrative-graph-operations.jsonl'
        ),
        indexFile: resolve(memory.directory, 'narrative-graph-index.json'),
        dirtyFile: resolve(memory.directory, 'narrative-graph-dirty.json'),
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
    fileSystem: GraphFileSystem,
    userDataDirectory: string,
    workspace: NarrativeGraphWorkspace
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
                throw new Error('Graph workspace contains a symbolic link')
            }
            if (!status.isDirectory()) {
                throw new Error('Graph workspace path is not a directory')
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await fileSystem.mkdir(current)
        }
    }
    if (!isWithin(realRoot, await fileSystem.realpath(workspace.directory))) {
        throw new Error('Graph workspace escapes user data')
    }
}

async function assertSafeFile(
    fileSystem: GraphFileSystem,
    file: string
): Promise<void> {
    try {
        const status = await fileSystem.lstat(file)
        if (status.isSymbolicLink() || !status.isFile()) {
            throw new Error('Graph workspace target is not a regular file')
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
}

async function writeAtomically(
    fileSystem: GraphFileSystem,
    file: string,
    value: unknown
): Promise<void> {
    const temporary = `${file}.tmp-${randomUUID()}`
    let handle: Awaited<ReturnType<typeof nodeFs.open>> | undefined
    try {
        handle = await fileSystem.open(temporary, 'wx', 0o600)
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8')
        await handle.sync()
        await handle.close()
        handle = undefined
        await fileSystem.rename(temporary, file)
    }
    catch (error) {
        await handle?.close().catch(() => undefined)
        await fileSystem.rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
}

async function appendSafely(
    fileSystem: GraphFileSystem,
    file: string,
    contents: Uint8Array
): Promise<void> {
    const handle = await fileSystem.open(
        file,
        constants.O_APPEND
            | constants.O_CREAT
            | constants.O_WRONLY
            | (constants.O_NOFOLLOW ?? 0),
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

async function readOperationLog(
    fileSystem: GraphFileSystem,
    file: string
): Promise<{
    operationIds: Set<string>
    operationsById: Map<string, string>
    deltas: NarrativeGraphOperation[][]
    partialTail: Buffer
}> {
    let contents: Buffer
    try {
        contents = await fileSystem.readFile(file)
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return {
                operationIds: new Set(),
                operationsById: new Map(),
                deltas: [],
                partialTail: Buffer.alloc(0),
            }
        }
        throw error
    }
    const lastLineFeed = contents.lastIndexOf(0x0a)
    const complete = lastLineFeed < 0
        ? Buffer.alloc(0)
        : contents.subarray(0, lastLineFeed)
    const partialTail = contents.subarray(lastLineFeed + 1)
    const operationIds = new Set<string>()
    const operationsById = new Map<string, string>()
    const deltas: NarrativeGraphOperation[][] = []
    for (const line of complete.length === 0
        ? []
        : complete.toString('utf8').split('\n')) {
        const record = JSON.parse(line)
        if (!isRecord(record) || record.schemaVersion !== 2) {
            throw new Error('Invalid graph operation record')
        }
        assertExactKeys(
            record,
            ['schemaVersion', 'operationIds', 'operations'],
            'graph operation record'
        )
        if (!Array.isArray(record.operationIds)
            || !Array.isArray(record.operations)
            || record.operationIds.length === 0
            || record.operationIds.length !== record.operations.length) {
            throw new Error('Invalid stored graph operation payload')
        }
        const delta: NarrativeGraphOperation[] = []
        for (let index = 0; index < record.operations.length; index += 1) {
            if (!Object.prototype.hasOwnProperty.call(
                record.operations,
                index
            ) || !Object.prototype.hasOwnProperty.call(
                record.operationIds,
                index
            )) {
                throw new Error('Stored graph delta must be dense')
            }
            const operationId = requireString(
                record.operationIds[index],
                'Stored graph operation ID'
            )
            const operation = record.operations[index]
            if (!isRecord(operation)
                || operation.operationId !== operationId) {
                throw new Error('Invalid stored graph operation payload')
            }
            const serializedOperation = JSON.stringify(operation)
            const previous = operationsById.get(operationId)
            if (previous !== undefined && previous !== serializedOperation) {
                throw new Error('Graph operation payload mismatch')
            }
            operationIds.add(operationId)
            operationsById.set(operationId, serializedOperation)
            const storedOperation = structuredClone(operation)
            delta.push(
                storedOperation as unknown as NarrativeGraphOperation
            )
        }
        deltas.push(delta)
    }
    return { operationIds, operationsById, deltas, partialTail }
}

function operationEvidence(
    operation: NarrativeGraphOperation
): EvidenceRef[] {
    if (operation.type === 'add-node') return operation.node.evidence
    if (operation.type === 'add-edge') return operation.edge.evidence
    return operation.evidence
}

function parseStoredState(value: unknown): NarrativeGraphStateV2 {
    if (!isRecord(value) || value.schemaVersion !== 2) {
        throw new Error('Unsupported stored graph schema version')
    }
    assertExactKeys(value, ['schemaVersion', 'state'], 'stored graph')
    return validateNarrativeGraphState(value.state)
}

export function createNarrativeGraphFileAdapter(
    userDataDirectory: string,
    fileSystem: GraphFileSystem = nodeFs
) {
    requireString(userDataDirectory, 'userDataDirectory')
    if (!isAbsolute(userDataDirectory)) {
        throw new Error('userDataDirectory must be absolute')
    }
    const workspaceFor = (characterId: string, chatId: string) =>
        resolveNarrativeGraphWorkspace(
            userDataDirectory,
            characterId,
            chatId
        )
    const operationLogCache = new Map<
        string,
        Awaited<ReturnType<typeof readOperationLog>>
    >()

    return {
        async isIndexDirty(
            characterId: string,
            chatId: string
        ): Promise<boolean> {
            const workspace = workspaceFor(characterId, chatId)
            try {
                await fileSystem.lstat(workspace.dirtyFile)
                await ensureSafeWorkspace(
                    fileSystem,
                    userDataDirectory,
                    workspace
                )
                await assertSafeFile(fileSystem, workspace.dirtyFile)
                return true
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return false
                }
                throw error
            }
        },

        async markIndexDirty(
            characterId: string,
            chatId: string
        ): Promise<void> {
            const workspace = workspaceFor(characterId, chatId)
            await ensureSafeWorkspace(
                fileSystem,
                userDataDirectory,
                workspace
            )
            await assertSafeFile(fileSystem, workspace.dirtyFile)
            await writeAtomically(fileSystem, workspace.dirtyFile, {
                schemaVersion: 1,
                status: 'out-of-sync',
            })
        },

        async clearIndexDirty(
            characterId: string,
            chatId: string
        ): Promise<void> {
            const workspace = workspaceFor(characterId, chatId)
            try {
                await fileSystem.lstat(workspace.dirtyFile)
                await ensureSafeWorkspace(
                    fileSystem,
                    userDataDirectory,
                    workspace
                )
                await assertSafeFile(fileSystem, workspace.dirtyFile)
                await fileSystem.rm(workspace.dirtyFile, { force: true })
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error
                }
            }
        },

        async invalidateIndexArtifact(
            characterId: string,
            chatId: string
        ): Promise<void> {
            const workspace = workspaceFor(characterId, chatId)
            try {
                await fileSystem.lstat(workspace.indexFile)
                await ensureSafeWorkspace(
                    fileSystem,
                    userDataDirectory,
                    workspace
                )
                await assertSafeFile(fileSystem, workspace.indexFile)
                await fileSystem.rm(workspace.indexFile, { force: true })
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error
                }
            }
        },

        async loadState(
            characterId: string,
            chatId: string
        ): Promise<NarrativeGraphStateV2> {
            const workspace = workspaceFor(characterId, chatId)
            let state: NarrativeGraphStateV2
            try {
                await fileSystem.lstat(workspace.stateFile)
                await ensureSafeWorkspace(
                    fileSystem,
                    userDataDirectory,
                    workspace
                )
                await assertSafeFile(fileSystem, workspace.stateFile)
                state = parseStoredState(JSON.parse(await fileSystem.readFile(
                    workspace.stateFile,
                    'utf8'
                )))
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    state = {
                        schemaVersion: 2,
                        storyId: requireString(characterId, 'characterId'),
                        branchId: requireString(chatId, 'chatId'),
                        revision: 0,
                        nodes: [],
                        edges: [],
                        appliedOperationIds: [],
                    }
                }
                else {
                    throw error
                }
            }

            let log: Awaited<ReturnType<typeof readOperationLog>>
            try {
                await fileSystem.lstat(workspace.operationsFile)
                await ensureSafeWorkspace(
                    fileSystem,
                    userDataDirectory,
                    workspace
                )
                await assertSafeFile(fileSystem, workspace.operationsFile)
                log = await readOperationLog(
                    fileSystem,
                    workspace.operationsFile
                )
                operationLogCache.set(workspace.operationsFile, log)
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return state
                }
                throw error
            }
            let recovered = state
            let changed = false
            for (const delta of log.deltas) {
                const applied = new Set(recovered.appliedOperationIds)
                const statuses = delta.map((operation) =>
                    applied.has(operation.operationId)
                )
                if (statuses.every(Boolean)) continue
                if (statuses.some(Boolean)) {
                    throw new Error(
                        'Stored graph delta is only partially applied'
                    )
                }
                recovered = applyNarrativeGraphDelta(recovered, {
                    schemaVersion: 2,
                    storyId: recovered.storyId,
                    branchId: recovered.branchId,
                    operations: delta,
                }, delta.flatMap((operation) =>
                    operationEvidence(operation).map((item) => ({ ...item }))
                ))
                changed = true
            }
            if (!changed) return recovered
            await writeAtomically(fileSystem, workspace.stateFile, {
                schemaVersion: 2,
                state: recovered,
            })
            await fileSystem.rm(workspace.indexFile, {
                force: true,
            }).catch(() => undefined)
            return recovered
        },

        async loadIndexArtifact(
            characterId: string,
            chatId: string
        ): Promise<unknown> {
            const workspace = workspaceFor(characterId, chatId)
            await fileSystem.lstat(workspace.indexFile)
            await ensureSafeWorkspace(
                fileSystem,
                userDataDirectory,
                workspace
            )
            await assertSafeFile(fileSystem, workspace.indexFile)
            const stored = JSON.parse(await fileSystem.readFile(
                workspace.indexFile,
                'utf8'
            ))
            if (!isRecord(stored) || stored.schemaVersion !== 1) {
                throw new Error('Unsupported graph index artifact')
            }
            assertExactKeys(
                stored,
                ['schemaVersion', 'index'],
                'graph index artifact'
            )
            return stored.index
        },

        async persistUpdate(
            characterId: string,
            chatId: string,
            update: NarrativeGraphUpdate
        ): Promise<void> {
            const workspace = workspaceFor(characterId, chatId)
            const previous = validateNarrativeGraphState(update.previousState)
            const state = validateNarrativeGraphState(update.state)
            if (state.storyId !== characterId || state.branchId !== chatId) {
                throw new Error('Graph state is outside storage scope')
            }
            if (update.index.revision !== state.revision
                || update.index.storyId !== state.storyId
                || update.index.branchId !== state.branchId) {
                throw new Error('Graph index does not match state revision')
            }
            const previousIds = new Set(previous.appliedOperationIds)
            const appliedIds = new Set(state.appliedOperationIds)
            const operations = update.operations.filter(
                (operation) => !previousIds.has(operation.operationId)
            )
            for (const operation of operations) {
                if (!appliedIds.has(operation.operationId)) {
                    throw new Error(
                        `Graph state is missing operation: ${operation.operationId}`
                    )
                }
            }

            await ensureSafeWorkspace(
                fileSystem,
                userDataDirectory,
                workspace
            )
            await Promise.all([
                assertSafeFile(fileSystem, workspace.stateFile),
                assertSafeFile(fileSystem, workspace.operationsFile),
                assertSafeFile(fileSystem, workspace.indexFile),
            ])
            const log = operationLogCache.get(workspace.operationsFile)
                ?? await readOperationLog(
                    fileSystem,
                    workspace.operationsFile
                )
            operationLogCache.set(workspace.operationsFile, log)
            const loggedStatuses = operations.map((operation) =>
                log.operationIds.has(operation.operationId)
            )
            for (const operation of operations) {
                if (log.operationIds.has(operation.operationId)
                    && log.operationsById.get(operation.operationId)
                        !== JSON.stringify(operation)) {
                    throw new Error('Graph operation payload mismatch')
                }
            }
            if (loggedStatuses.some(Boolean)
                && !loggedStatuses.every(Boolean)) {
                throw new Error('Graph delta log is only partially present')
            }
            if (operations.length > 0 && !loggedStatuses.every(Boolean)) {
                const serialized = Buffer.from(JSON.stringify({
                    schemaVersion: 2,
                    operationIds: operations.map(
                        (operation) => operation.operationId
                    ),
                    operations,
                }))
                if (log.partialTail.length > 0
                    && !serialized.subarray(0, log.partialTail.length)
                        .equals(log.partialTail)) {
                    throw new Error(
                        'Graph operation log has an unrecoverable partial tail'
                    )
                }
                const remainder = log.partialTail.length > 0
                    ? serialized.subarray(log.partialTail.length)
                    : serialized
                await appendSafely(
                    fileSystem,
                    workspace.operationsFile,
                    Buffer.concat([remainder, Buffer.from('\n')])
                )
                log.partialTail = Buffer.alloc(0)
                for (const operation of operations) {
                    log.operationIds.add(operation.operationId)
                    log.operationsById.set(
                        operation.operationId,
                        JSON.stringify(operation)
                    )
                }
                log.deltas.push(structuredClone(operations))
            }
            if (log.partialTail.length > 0) {
                throw new Error(
                    'Graph operation log has an unrecoverable partial tail'
                )
            }
            await writeAtomically(fileSystem, workspace.stateFile, {
                schemaVersion: 2,
                state,
            })
            await writeAtomically(fileSystem, workspace.indexFile, {
                schemaVersion: 1,
                index: update.index,
            })
        },
    }
}
