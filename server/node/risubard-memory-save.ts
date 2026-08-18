import * as nodeFs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
    completeMemoryWorkspaceFork,
    forkMemoryWorkspace,
    type MemoryForkReceipt,
} from './risubard-memory-fork'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

const SAVE_MANIFEST = 'risubard-save.json'
const SAVE_CHAT = 'chat.bin'
const SAVE_PREFIX = 'save-slot:'

export interface MemorySaveEventPreview {
    title: string
    excerpt: string
}

export interface MemorySaveSlotSummary {
    saveId: string
    sourceChatId: string
    sourceChatName: string
    createdAt: string
    turnCount: number
    latestEvent?: MemorySaveEventPreview
}

interface StoredMemorySaveManifest extends MemorySaveSlotSummary {
    schemaVersion: 1
}

type SaveFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'readdir' | 'readFile' | 'rm' | 'writeFile'
>

function required(value: unknown, label: string, maximum = 1_024): string {
    if (typeof value !== 'string'
        || value.trim().length === 0
        || value.length > maximum) {
        throw new Error(`${label} must be a non-empty bounded string`)
    }
    return value
}

export function memorySaveWorkspaceId(saveId: string): string {
    return `${SAVE_PREFIX}${required(saveId, 'saveId')}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEventPreview(value: unknown): MemorySaveEventPreview {
    if (!isRecord(value)
        || Object.keys(value).length !== 2
        || typeof value.title !== 'string'
        || value.title.trim().length === 0
        || value.title.length > 512
        || typeof value.excerpt !== 'string'
        || value.excerpt.length > 1_000) {
        throw new Error('Invalid memory save event preview')
    }
    return { title: value.title, excerpt: value.excerpt }
}

function parseManifest(value: unknown): StoredMemorySaveManifest {
    if (!isRecord(value)) throw new Error('Invalid memory save manifest')
    const hasEvent = value.latestEvent !== undefined
    const keys = [
        'schemaVersion', 'saveId', 'sourceChatId', 'sourceChatName',
        'createdAt', 'turnCount', ...(hasEvent ? ['latestEvent'] : []),
    ]
    if (Object.keys(value).length !== keys.length
        || !keys.every((key) => Object.hasOwn(value, key))
        || value.schemaVersion !== 1
        || typeof value.saveId !== 'string'
        || typeof value.sourceChatId !== 'string'
        || typeof value.sourceChatName !== 'string'
        || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt))
        || !Number.isSafeInteger(value.turnCount)
        || (value.turnCount as number) < 0) {
        throw new Error('Invalid memory save manifest')
    }
    return {
        schemaVersion: 1,
        saveId: required(value.saveId, 'saved saveId'),
        sourceChatId: required(value.sourceChatId, 'saved sourceChatId'),
        sourceChatName: required(value.sourceChatName, 'saved chat name', 512),
        createdAt: value.createdAt,
        turnCount: value.turnCount as number,
        ...(hasEvent ? { latestEvent: parseEventPreview(value.latestEvent) } : {}),
    }
}

function summaryOf(manifest: StoredMemorySaveManifest): MemorySaveSlotSummary {
    const { schemaVersion: _schemaVersion, ...summary } = manifest
    return summary
}

function workspaceFor(
    userDataDirectory: string,
    characterId: string,
    saveId: string
) {
    return resolveMemoryWorkspace(
        userDataDirectory,
        characterId,
        memorySaveWorkspaceId(saveId)
    )
}

async function safeFile(
    fileSystem: SaveFileSystem,
    path: string,
    label: string
): Promise<void> {
    const status = await fileSystem.lstat(path)
    if (status.isSymbolicLink() || !status.isFile()) {
        throw new Error(`${label} is unsafe`)
    }
}

async function validatedSave(
    fileSystem: SaveFileSystem,
    input: { userDataDirectory: string; characterId: string; saveId: string }
): Promise<{
    directory: string
    manifestPath: string
    chatPath: string
    manifest: StoredMemorySaveManifest
}> {
    const characterId = required(input.characterId, 'characterId')
    const saveId = required(input.saveId, 'saveId')
    const workspace = workspaceFor(input.userDataDirectory, characterId, saveId)
    const manifestPath = join(workspace.directory, SAVE_MANIFEST)
    const chatPath = join(workspace.directory, SAVE_CHAT)
    await safeFile(fileSystem, manifestPath, 'Memory save manifest')
    await safeFile(fileSystem, chatPath, 'Memory save chat')
    const manifest = parseManifest(JSON.parse(
        await fileSystem.readFile(manifestPath, 'utf8')
    ))
    if (manifest.saveId !== saveId) {
        throw new Error('Invalid memory save manifest')
    }
    return {
        directory: workspace.directory,
        manifestPath,
        chatPath,
        manifest,
    }
}

export async function createMemorySaveSlot(input: {
    userDataDirectory: string
    characterId: string
    sourceChatId: string
    saveId: string
    sourceChatName: string
    turnCount: number
    chatBytes: Uint8Array
    createdAt?: string
    latestEvent?: MemorySaveEventPreview
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveSlotSummary> {
    const fileSystem = options.fileSystem ?? nodeFs
    const saveId = required(input.saveId, 'saveId')
    const sourceChatId = required(input.sourceChatId, 'sourceChatId')
    const sourceChatName = required(input.sourceChatName, 'sourceChatName', 512)
    if (!Number.isSafeInteger(input.turnCount) || input.turnCount < 0) {
        throw new Error('turnCount must be a non-negative safe integer')
    }
    if (!(input.chatBytes instanceof Uint8Array)
        || input.chatBytes.byteLength === 0) {
        throw new Error('chatBytes must not be empty')
    }
    const createdAt = input.createdAt ?? new Date().toISOString()
    if (!Number.isFinite(Date.parse(createdAt))) {
        throw new Error('createdAt must be an ISO-compatible date')
    }
    const manifest: StoredMemorySaveManifest = {
        schemaVersion: 1,
        saveId,
        sourceChatId,
        sourceChatName,
        createdAt,
        turnCount: input.turnCount,
        ...(input.latestEvent
            ? { latestEvent: parseEventPreview(input.latestEvent) }
            : {}),
    }
    const destinationChatId = memorySaveWorkspaceId(saveId)
    let receipt: MemoryForkReceipt | undefined
    try {
        receipt = await forkMemoryWorkspace({
            userDataDirectory: input.userDataDirectory,
            characterId: required(input.characterId, 'characterId'),
            sourceChatId,
            destinationChatId,
            mode: 'copy',
        })
        const workspace = workspaceFor(
            input.userDataDirectory, input.characterId, saveId
        )
        await fileSystem.writeFile(
            join(workspace.directory, SAVE_CHAT),
            input.chatBytes,
            { flag: 'wx', mode: 0o600 }
        )
        await fileSystem.writeFile(
            join(workspace.directory, SAVE_MANIFEST),
            JSON.stringify(manifest),
            { encoding: 'utf8', flag: 'wx', mode: 0o600 }
        )
        await completeMemoryWorkspaceFork({
            userDataDirectory: input.userDataDirectory,
            characterId: input.characterId,
            destinationChatId,
            forkToken: receipt.forkToken,
            action: 'finalize',
        })
        return summaryOf(manifest)
    }
    catch (error) {
        if (receipt) {
            await completeMemoryWorkspaceFork({
                userDataDirectory: input.userDataDirectory,
                characterId: input.characterId,
                destinationChatId,
                forkToken: receipt.forkToken,
                action: 'discard',
            }).catch(() => undefined)
        }
        throw error
    }
}

export async function listMemorySaveSlots(input: {
    userDataDirectory: string
    characterId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveSlotSummary[]> {
    const fileSystem = options.fileSystem ?? nodeFs
    const probe = resolveMemoryWorkspace(
        input.userDataDirectory,
        required(input.characterId, 'characterId'),
        'save-list-probe'
    )
    const chatsDirectory = dirname(probe.directory)
    let entries
    try {
        entries = await fileSystem.readdir(chatsDirectory, { withFileTypes: true })
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw error
    }
    const summaries: MemorySaveSlotSummary[] = []
    for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue
        const directory = join(chatsDirectory, entry.name)
        const manifestPath = join(directory, SAVE_MANIFEST)
        const chatPath = join(directory, SAVE_CHAT)
        try {
            await safeFile(fileSystem, manifestPath, 'Memory save manifest')
            await safeFile(fileSystem, chatPath, 'Memory save chat')
            const manifest = parseManifest(JSON.parse(
                await fileSystem.readFile(manifestPath, 'utf8')
            ))
            if (workspaceFor(
                input.userDataDirectory, input.characterId, manifest.saveId
            ).directory !== directory) continue
            summaries.push(summaryOf(manifest))
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
            if (error instanceof SyntaxError
                || (error instanceof Error
                    && error.message.startsWith('Invalid memory save'))) continue
            throw error
        }
    }
    return summaries.sort((left, right) =>
        right.createdAt.localeCompare(left.createdAt)
        || left.saveId.localeCompare(right.saveId)
    )
}

export async function readMemorySaveChat(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<Buffer> {
    const fileSystem = options.fileSystem ?? nodeFs
    const saved = await validatedSave(fileSystem, input)
    return Buffer.from(await fileSystem.readFile(saved.chatPath))
}

export async function renameMemorySaveSlot(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
    name: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<MemorySaveSlotSummary> {
    const fileSystem = options.fileSystem ?? nodeFs
    const name = required(input.name, 'saved file name', 512)
    const saved = await validatedSave(fileSystem, input)
    const manifest: StoredMemorySaveManifest = {
        ...saved.manifest,
        sourceChatName: name,
    }
    await fileSystem.writeFile(
        saved.manifestPath,
        JSON.stringify(manifest),
        { encoding: 'utf8', mode: 0o600 }
    )
    return summaryOf(manifest)
}

export async function deleteMemorySaveSlot(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<void> {
    const fileSystem = options.fileSystem ?? nodeFs
    const saved = await validatedSave(fileSystem, input)
    await fileSystem.rm(saved.directory, { recursive: true, force: false })
}

export async function prepareMemorySaveLoad(input: {
    userDataDirectory: string
    characterId: string
    saveId: string
    destinationChatId: string
}, options: { fileSystem?: SaveFileSystem } = {}): Promise<{
    chatBytes: Buffer
    save: MemorySaveSlotSummary
    fork: MemoryForkReceipt
}> {
    const fileSystem = options.fileSystem ?? nodeFs
    const sourceChatId = memorySaveWorkspaceId(input.saveId)
    const workspace = workspaceFor(
        input.userDataDirectory, input.characterId, input.saveId
    )
    const manifestPath = join(workspace.directory, SAVE_MANIFEST)
    const chatPath = join(workspace.directory, SAVE_CHAT)
    await safeFile(fileSystem, manifestPath, 'Memory save manifest')
    await safeFile(fileSystem, chatPath, 'Memory save chat')
    const manifest = parseManifest(JSON.parse(
        await fileSystem.readFile(manifestPath, 'utf8')
    ))
    const chatBytes = Buffer.from(await fileSystem.readFile(chatPath))
    const fork = await forkMemoryWorkspace({
        userDataDirectory: input.userDataDirectory,
        characterId: required(input.characterId, 'characterId'),
        sourceChatId,
        destinationChatId: required(
            input.destinationChatId, 'destinationChatId'
        ),
        mode: 'copy',
    })
    try {
        const destination = resolveMemoryWorkspace(
            input.userDataDirectory,
            input.characterId,
            input.destinationChatId
        )
        await fileSystem.rm(join(destination.directory, SAVE_MANIFEST), {
            force: false,
        })
        await fileSystem.rm(join(destination.directory, SAVE_CHAT), {
            force: false,
        })
        return { chatBytes, save: summaryOf(manifest), fork }
    }
    catch (error) {
        await completeMemoryWorkspaceFork({
            userDataDirectory: input.userDataDirectory,
            characterId: input.characterId,
            destinationChatId: input.destinationChatId,
            forkToken: fork.forkToken,
            action: 'discard',
        }).catch(() => undefined)
        throw error
    }
}
