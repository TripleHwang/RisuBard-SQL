import * as nodeFs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

export type MemoryForkMode = 'copy' | 'branch'

export interface MemoryForkInput {
    userDataDirectory: string
    characterId: string
    destinationCharacterId?: string
    sourceChatId: string
    destinationChatId: string
    mode: MemoryForkMode
    retainedMessageIds?: string[]
    messageIds?: string[]
}

export interface MemoryForkReceipt {
    mode: MemoryForkMode
    sourceExists: boolean
    destinationChatId: string
    warnings: string[]
    forkToken: string
}

export interface CompleteMemoryForkInput {
    userDataDirectory: string
    characterId: string
    destinationChatId: string
    forkToken: string
    action: 'finalize' | 'discard'
}

export interface CompleteMemoryForkReceipt {
    action: 'finalize' | 'discard'
    completed: true
}

type ForkFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'readdir' | 'readFile' | 'writeFile'
    | 'copyFile' | 'rename' | 'rm' | 'realpath'
>

interface SnapshotChange {
    documentId: string
    undoneAt?: string
}

interface SnapshotReceipt {
    sourceMessageIds: string[]
    eventIds: string[]
    changes: SnapshotChange[]
    recordedAt: string
    undoneAt?: string
}

interface SnapshotManifest {
    snapshotId: string
    created: string
    sourceMessageIds: string[]
    documents: Array<{
        id: string
        type: string
        relativePath: string
    }>
    receipt?: SnapshotReceipt
}

interface StoredDocument {
    id: string
    type: string
    title: string
    authoring?: string
    sourceMessageIds: string[]
    relativePath: string
    contents: string
}

const FORK_MARKER = '.risubard-fork.json'

function replacementBackupPath(directory: string, forkToken: string): string {
    return `${directory}.restore-${Buffer.from(forkToken).toString('base64url')}`
}

function replacementStagingPath(directory: string, forkToken: string): string {
    return `${directory}.replace-${Buffer.from(forkToken).toString('base64url')}`
}

function completionReceiptPath(directory: string, forkToken: string): string {
    return `${directory}.fork-complete-${Buffer.from(forkToken).toString('base64url')}.json`
}

export function resolveMemoryReplacementStaging(
    userDataDirectory: string,
    characterId: string,
    destinationChatId: string,
    forkToken: string
): string {
    return replacementStagingPath(resolveMemoryWorkspace(
        userDataDirectory,
        required(characterId, 'characterId'),
        required(destinationChatId, 'destinationChatId')
    ).directory, required(forkToken, 'forkToken'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function required(value: string, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function isWithin(root: string, target: string): boolean {
    const relation = relative(root, target)
    return relation === '' || (relation !== '..'
        && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        && !isAbsolute(relation))
}

function childPath(root: string, relativePath: string): string {
    const normalized = required(relativePath, 'Relative path')
        .replaceAll('\\', '/')
    const target = resolve(root, ...normalized.split('/'))
    if (!isWithin(root, target) || target === resolve(root)) {
        throw new Error('Memory fork path escapes its workspace')
    }
    return target
}

async function exists(fileSystem: ForkFileSystem, path: string): Promise<boolean> {
    try {
        await fileSystem.lstat(path)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

async function ensureSafeParent(
    fileSystem: ForkFileSystem,
    userDataDirectory: string,
    targetParent: string
): Promise<void> {
    await fileSystem.mkdir(userDataDirectory, { recursive: true })
    const root = await fileSystem.realpath(userDataDirectory)
    if (!isWithin(userDataDirectory, targetParent)) {
        throw new Error('Memory fork destination escapes user data')
    }
    let current = resolve(userDataDirectory)
    for (const segment of relative(current, targetParent).split(/[\\/]/)) {
        if (!segment) continue
        current = resolve(current, segment)
        try {
            const status = await fileSystem.lstat(current)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Memory fork destination path is unsafe')
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await fileSystem.mkdir(current)
        }
    }
    if (!isWithin(root, await fileSystem.realpath(targetParent))) {
        throw new Error('Memory fork destination escapes user data')
    }
}

async function copyDirectoryContents(
    fileSystem: ForkFileSystem,
    source: string,
    destination: string
): Promise<void> {
    for (const entry of await fileSystem.readdir(source, { withFileTypes: true })) {
        const sourcePath = join(source, entry.name)
        const destinationPath = join(destination, entry.name)
        const status = await fileSystem.lstat(sourcePath)
        if (status.isSymbolicLink()) {
            throw new Error('Memory fork source contains a symbolic link')
        }
        if (status.isDirectory()) {
            await fileSystem.mkdir(destinationPath)
            await copyDirectoryContents(fileSystem, sourcePath, destinationPath)
            continue
        }
        if (!status.isFile()) {
            throw new Error('Memory fork source contains a non-regular file')
        }
        await fileSystem.copyFile(sourcePath, destinationPath)
    }
}

function jsonRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Invalid memory fork snapshot manifest')
    }
    return value as Record<string, unknown>
}

function stringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value) || !value.every((item) =>
        typeof item === 'string' && item.length > 0
    )) throw new Error(`Invalid ${label}`)
    return value
}

function parseManifest(value: unknown): SnapshotManifest {
    const record = jsonRecord(value)
    const documents = Array.isArray(record.documents)
        ? record.documents.map((item) => {
            const document = jsonRecord(item)
            return {
                id: required(document.id as string, 'Snapshot document ID'),
                type: required(document.type as string, 'Snapshot document type'),
                relativePath: required(
                    document.relativePath as string,
                    'Snapshot document path'
                ),
            }
        })
        : (() => { throw new Error('Invalid snapshot documents') })()
    let receipt: SnapshotReceipt | undefined
    if (record.receipt !== undefined) {
        const stored = jsonRecord(record.receipt)
        receipt = {
            sourceMessageIds: stringArray(
                stored.sourceMessageIds,
                'snapshot receipt sources'
            ),
            eventIds: stringArray(stored.eventIds, 'snapshot receipt events'),
            changes: Array.isArray(stored.changes)
                ? stored.changes.map((item) => {
                    const change = jsonRecord(item)
                    return {
                        documentId: required(
                            change.documentId as string,
                            'Snapshot change document ID'
                        ),
                        ...(typeof change.undoneAt === 'string'
                            ? { undoneAt: change.undoneAt }
                            : {}),
                    }
                })
                : (() => { throw new Error('Invalid snapshot receipt changes') })(),
            recordedAt: required(
                stored.recordedAt as string,
                'Snapshot receipt time'
            ),
            ...(typeof stored.undoneAt === 'string'
                ? { undoneAt: stored.undoneAt }
                : {}),
        }
    }
    if (receipt
        && JSON.stringify(receipt.sourceMessageIds)
            !== JSON.stringify(stringArray(
                record.sourceMessageIds,
                'snapshot sources'
            ))) {
        throw new Error('Snapshot and receipt source mismatch')
    }
    return {
        snapshotId: required(record.snapshotId as string, 'Snapshot ID'),
        created: required(record.created as string, 'Snapshot created time'),
        sourceMessageIds: stringArray(record.sourceMessageIds, 'snapshot sources'),
        documents,
        ...(receipt ? { receipt } : {}),
    }
}

function frontmatterScalar(contents: string, key: string): string | undefined {
    const match = contents.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))
    if (!match) return undefined
    const value = match[1].trim()
    try {
        const parsed: unknown = JSON.parse(value)
        return typeof parsed === 'string' ? parsed : value
    }
    catch {
        return value
    }
}

function frontmatterList(contents: string, key: string): string[] {
    const lines = contents.split(/\r?\n/)
    const start = lines.findIndex((line) => line.trim() === `${key}:`)
    if (start < 0) return []
    const values: string[] = []
    for (const line of lines.slice(start + 1)) {
        const match = line.match(/^\s+-\s+(.+)$/)
        if (!match) break
        try {
            const parsed: unknown = JSON.parse(match[1])
            if (typeof parsed === 'string') values.push(parsed)
        }
        catch {
            values.push(match[1].trim())
        }
    }
    return values
}

async function collectMarkdownFiles(
    fileSystem: ForkFileSystem,
    directory: string,
    prefix: string
): Promise<string[]> {
    if (!await exists(fileSystem, directory)) return []
    const files: string[] = []
    for (const entry of await fileSystem.readdir(directory, { withFileTypes: true })) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
            files.push(...await collectMarkdownFiles(
                fileSystem,
                join(directory, entry.name),
                relativePath
            ))
        }
        else if (entry.isFile() && entry.name.endsWith('.md')) {
            files.push(relativePath)
        }
        else if (entry.isSymbolicLink()) {
            throw new Error('Memory fork wiki contains a symbolic link')
        }
    }
    return files
}

async function loadDocuments(
    fileSystem: ForkFileSystem,
    wikiDirectory: string,
    paths: string[]
): Promise<StoredDocument[]> {
    return Promise.all(paths.map(async (relativePath) => {
        const contents = await fileSystem.readFile(
            childPath(wikiDirectory, relativePath),
            'utf8'
        )
        return {
            id: required(frontmatterScalar(contents, 'id') ?? '', 'Wiki document ID'),
            type: required(
                frontmatterScalar(contents, 'type') ?? '',
                'Wiki document type'
            ),
            title: frontmatterScalar(contents, 'title') ?? relativePath,
            authoring: frontmatterScalar(contents, 'authoring'),
            sourceMessageIds: frontmatterList(contents, 'source_messages'),
            relativePath,
            contents,
        }
    }))
}

async function readManifests(
    fileSystem: ForkFileSystem,
    snapshotsDirectory: string
): Promise<Array<{ directory: string; manifest: SnapshotManifest }>> {
    if (!await exists(fileSystem, snapshotsDirectory)) return []
    const result: Array<{ directory: string; manifest: SnapshotManifest }> = []
    for (const entry of await fileSystem.readdir(
        snapshotsDirectory,
        { withFileTypes: true }
    )) {
        if (!entry.isDirectory()) continue
        const directory = join(snapshotsDirectory, entry.name)
        const manifest = parseManifest(JSON.parse(await fileSystem.readFile(
            join(directory, 'manifest.json'),
            'utf8'
        )))
        if (manifest.snapshotId !== entry.name) {
            throw new Error('Snapshot directory does not match its manifest')
        }
        result.push({ directory, manifest })
    }
    return result.sort((left, right) =>
        left.manifest.snapshotId.localeCompare(right.manifest.snapshotId)
    )
}

const canonicalFolders = [
    'characters', 'locations', 'factions', 'items', 'concepts', 'notes',
]

async function reconstructBranch(
    fileSystem: ForkFileSystem,
    stagingDirectory: string,
    retainedMessageIds: string[],
    messageIds: string[]
): Promise<string[]> {
    const retained = new Set(retainedMessageIds)
    const messageIndex = new Map(messageIds.map((id, index) => [id, index]))
    const wikiDirectory = join(stagingDirectory, 'wiki')
    if (!await exists(fileSystem, wikiDirectory)) return []
    const snapshotsDirectory = join(wikiDirectory, '.risubard-snapshots')
    const manifests = await readManifests(fileSystem, snapshotsDirectory)
    const future = manifests.filter(({ manifest }) => {
        if (!manifest.receipt) return false
        for (const id of manifest.receipt.sourceMessageIds) {
            if (!messageIndex.has(id)) {
                throw new Error(
                    'Memory fork conflict: receipt source is absent from chat'
                )
            }
        }
        return manifest.receipt.sourceMessageIds.some((id) => !retained.has(id))
    }).sort((left, right) => {
        const position = (item: typeof left) => Math.min(
            ...item.manifest.receipt!.sourceMessageIds
                .filter((id) => !retained.has(id))
                .map((id) => messageIndex.get(id)!)
        )
        return position(left) - position(right)
            || left.manifest.snapshotId.localeCompare(
                right.manifest.snapshotId
            )
    })
    const boundary = future[0]

    const canonicalPaths = [
        ...(await exists(fileSystem, join(wikiDirectory, 'current-scene.md'))
            ? ['current-scene.md']
            : []),
        ...(await Promise.all(canonicalFolders.map((folder) =>
            collectMarkdownFiles(fileSystem, join(wikiDirectory, folder), folder)
        ))).flat(),
    ]
    const currentCanonical = await loadDocuments(
        fileSystem,
        wikiDirectory,
        canonicalPaths
    )
    const eventPaths = await collectMarkdownFiles(
        fileSystem,
        join(wikiDirectory, 'events'),
        'events'
    )
    const currentEvents = await loadDocuments(
        fileSystem,
        wikiDirectory,
        eventPaths
    )

    const uncoveredFutureCanonical = currentCanonical.filter((document) =>
        document.sourceMessageIds.some((id) => !retained.has(id))
        && !future.some(({ manifest }) => manifest.receipt?.changes.some(
            (change) => change.documentId === document.id
        ))
    )
    if (uncoveredFutureCanonical.length > 0) {
        throw new Error(
            'Memory fork conflict: future canonical changes lack a receipt'
        )
    }

    if (boundary) {
        const reviewDirectory = join(wikiDirectory, '.risubard-review')
        if (await exists(fileSystem, reviewDirectory)
            && (await fileSystem.readdir(reviewDirectory)).length > 0) {
            throw new Error(
                'Memory fork conflict: review state cannot be assigned to the cutoff'
            )
        }
        const futureChangedIds = new Set(future.flatMap(({ manifest }) =>
            manifest.receipt?.changes.map((change) => change.documentId) ?? []
        ))
        const baselineDocuments = boundary.manifest.documents.filter((item) =>
            item.type !== 'event'
        )
        const baselineContents = new Map<string, string>()
        for (const document of baselineDocuments) {
            baselineContents.set(document.id, await fileSystem.readFile(
                childPath(boundary.directory, document.relativePath),
                'utf8'
            ))
        }
        const manualDocuments = currentCanonical.filter((document) =>
            document.authoring === 'manual'
        )
        for (const document of manualDocuments) {
            if (document.sourceMessageIds.some((id) => !retained.has(id))) {
                throw new Error(
                    'Memory fork conflict: manual edit contains future sources'
                )
            }
            if (futureChangedIds.has(document.id)
                && baselineContents.get(document.id) !== document.contents) {
                throw new Error(
                    'Memory fork conflict: manual edit is mixed with future changes'
                )
            }
        }

        for (const path of canonicalPaths) {
            await fileSystem.rm(childPath(wikiDirectory, path), { force: true })
        }
        for (const document of baselineDocuments) {
            const target = childPath(wikiDirectory, document.relativePath)
            await fileSystem.mkdir(dirname(target), { recursive: true })
            await fileSystem.copyFile(
                childPath(boundary.directory, document.relativePath),
                target
            )
        }
        for (const document of manualDocuments) {
            if (futureChangedIds.has(document.id)) continue
            const baseline = baselineDocuments.find((item) =>
                item.id === document.id
            )
            if (baseline
                && baseline.relativePath !== document.relativePath) {
                await fileSystem.rm(
                    childPath(wikiDirectory, baseline.relativePath),
                    { force: true }
                )
            }
            const target = childPath(wikiDirectory, document.relativePath)
            await fileSystem.mkdir(dirname(target), { recursive: true })
            await fileSystem.writeFile(target, document.contents, 'utf8')
        }

        for (const internal of [
            '.risubard-history', '.risubard-trash', '.risubard-review',
        ]) await fileSystem.rm(join(wikiDirectory, internal), {
            recursive: true,
            force: true,
        })
        for (const legacy of [
            'narrative-state.json', 'events.jsonl',
            'narrative-graph-state.json', 'narrative-graph-operations.jsonl',
            'narrative-graph-index.json', 'narrative-graph-dirty.json',
            'baseline-summary.txt',
        ]) await fileSystem.rm(join(stagingDirectory, legacy), { force: true })
    }

    const futureEventIds = new Set(future.flatMap(({ manifest }) =>
        manifest.receipt?.eventIds ?? []
    ))
    for (const event of currentEvents) {
        if (futureEventIds.has(event.id)
            || event.sourceMessageIds.some((id) => !retained.has(id))) {
            await fileSystem.rm(
                childPath(wikiDirectory, event.relativePath),
                { force: true }
            )
        }
    }

    for (const { directory, manifest } of manifests) {
        if (manifest.sourceMessageIds.some((id) => !retained.has(id))) {
            await fileSystem.rm(directory, { recursive: true, force: true })
        }
    }

    const finalPaths = [
        ...(await exists(fileSystem, join(wikiDirectory, 'current-scene.md'))
            ? ['current-scene.md']
            : []),
        ...(await Promise.all(canonicalFolders.map((folder) =>
            collectMarkdownFiles(fileSystem, join(wikiDirectory, folder), folder)
        ))).flat(),
        ...await collectMarkdownFiles(
            fileSystem,
            join(wikiDirectory, 'events'),
            'events'
        ),
    ]
    const finalDocuments = await loadDocuments(fileSystem, wikiDirectory, finalPaths)
    await fileSystem.writeFile(join(wikiDirectory, 'index.md'), [
        '---',
        'type: narrative_wiki_index',
        'status: active',
        '---',
        '',
        '# 서사 위키',
        '',
        ...finalDocuments.map((document) =>
            `- [[${document.relativePath.replace(/\.md$/, '')}|${document.title}]]`
        ),
        '',
    ].join('\n'), 'utf8')
    return boundary
        ? ['non-turn-addressable audit and future-derived legacy state were reset']
        : []
}

export async function forkMemoryWorkspace(
    input: MemoryForkInput,
    options: { fileSystem?: ForkFileSystem } = {}
): Promise<MemoryForkReceipt> {
    required(input.characterId, 'characterId')
    required(input.sourceChatId, 'sourceChatId')
    required(input.destinationChatId, 'destinationChatId')
    if (input.mode !== 'copy' && input.mode !== 'branch') {
        throw new Error('Invalid memory fork mode')
    }
    if (input.sourceChatId === input.destinationChatId) {
        throw new Error('Memory fork source and destination must differ')
    }
    if (input.mode === 'branch'
        && (!Array.isArray(input.retainedMessageIds)
            || !Array.isArray(input.messageIds))) {
        throw new Error('Memory branch requires ordered message IDs')
    }
    const retained = input.retainedMessageIds ?? []
    const messageIds = input.messageIds ?? []
    if (retained.some((id) => typeof id !== 'string' || id.length === 0)
        || messageIds.some((id) => typeof id !== 'string' || id.length === 0)
        || new Set(messageIds).size !== messageIds.length
        || retained.length > messageIds.length
        || retained.some((id, index) => messageIds[index] !== id)) {
        throw new Error('Invalid branch message order')
    }
    const fileSystem = options.fileSystem ?? nodeFs
    const source = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.characterId,
        input.sourceChatId
    )
    const destination = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.destinationCharacterId ?? input.characterId,
        input.destinationChatId
    )
    await ensureSafeParent(
        fileSystem,
        input.userDataDirectory,
        dirname(destination.directory)
    )
    if (await exists(fileSystem, destination.directory)) {
        throw new Error('Memory fork destination already exists')
    }
    const staging = `${destination.directory}.fork-${randomUUID()}`
    const forkToken = randomUUID()
    let sourceExists = false
    try {
        await fileSystem.mkdir(staging)
        try {
            const status = await fileSystem.lstat(source.directory)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Memory fork source workspace is unsafe')
            }
            sourceExists = true
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (sourceExists) {
            await copyDirectoryContents(fileSystem, source.directory, staging)
        }
        await fileSystem.rm(join(staging, FORK_MARKER), { force: true })
        const warnings = input.mode === 'branch'
            ? await reconstructBranch(
                fileSystem,
                staging,
                retained,
                messageIds
            )
            : []
        await fileSystem.writeFile(join(staging, FORK_MARKER), JSON.stringify({
            destinationChatId: input.destinationChatId,
            forkToken,
        }), 'utf8')
        await fileSystem.rename(staging, destination.directory)
        return {
            mode: input.mode,
            sourceExists,
            destinationChatId: input.destinationChatId,
            warnings,
            forkToken,
        }
    }
    catch (error) {
        await fileSystem.rm(staging, { recursive: true, force: true })
            .catch(() => undefined)
        throw error
    }
}

export async function replaceMemoryWorkspace(
    input: Omit<MemoryForkInput, 'mode' | 'retainedMessageIds' | 'messageIds'>,
    options: { fileSystem?: ForkFileSystem } = {}
): Promise<MemoryForkReceipt> {
    required(input.characterId, 'characterId')
    required(input.sourceChatId, 'sourceChatId')
    required(input.destinationChatId, 'destinationChatId')
    if (input.sourceChatId === input.destinationChatId) {
        throw new Error('Memory replacement source and destination must differ')
    }
    const fileSystem = options.fileSystem ?? nodeFs
    const source = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.characterId,
        input.sourceChatId
    )
    const destination = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.destinationCharacterId ?? input.characterId,
        input.destinationChatId
    )
    await ensureSafeParent(
        fileSystem,
        input.userDataDirectory,
        dirname(destination.directory)
    )
    const forkToken = randomUUID()
    const staging = replacementStagingPath(destination.directory, forkToken)
    let sourceExists = false
    let hadDestination = false
    try {
        await fileSystem.mkdir(staging)
        try {
            const status = await fileSystem.lstat(source.directory)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Memory replacement source workspace is unsafe')
            }
            sourceExists = true
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (sourceExists) {
            await copyDirectoryContents(fileSystem, source.directory, staging)
        }
        await fileSystem.rm(join(staging, FORK_MARKER), { force: true })
        if (await exists(fileSystem, destination.directory)) {
            const status = await fileSystem.lstat(destination.directory)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Memory replacement destination is unsafe')
            }
            hadDestination = true
        }
        await fileSystem.writeFile(
            join(staging, FORK_MARKER),
            JSON.stringify({
                destinationChatId: input.destinationChatId,
                forkToken,
                replacement: true,
                hadDestination,
            }),
            'utf8'
        )
        return {
            mode: 'copy',
            sourceExists,
            destinationChatId: input.destinationChatId,
            warnings: [],
            forkToken,
        }
    }
    catch (error) {
        await fileSystem.rm(staging, { recursive: true, force: true })
            .catch(() => undefined)
        throw error
    }
}

export async function removeRebootMemoryWorkspace(input: {
    userDataDirectory: string
    characterId: string
    chatId: string
}, options: { fileSystem?: ForkFileSystem } = {}): Promise<{ removed: boolean }> {
    required(input.characterId, 'characterId')
    const chatId = required(input.chatId, 'chatId')
    if (!chatId.startsWith('reboot-')) {
        throw new Error('Only reboot staging workspaces can be removed')
    }
    const fileSystem = options.fileSystem ?? nodeFs
    const workspace = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.characterId,
        chatId
    )
    try {
        const status = await fileSystem.lstat(workspace.directory)
        if (status.isSymbolicLink() || !status.isDirectory()) {
            throw new Error('Reboot staging workspace is unsafe')
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { removed: false }
        }
        throw error
    }
    await fileSystem.rm(workspace.directory, { recursive: true, force: false })
    return { removed: true }
}

export async function completeMemoryWorkspaceFork(
    input: CompleteMemoryForkInput,
    options: { fileSystem?: ForkFileSystem } = {}
): Promise<CompleteMemoryForkReceipt> {
    required(input.characterId, 'characterId')
    required(input.destinationChatId, 'destinationChatId')
    required(input.forkToken, 'forkToken')
    if (input.action !== 'finalize' && input.action !== 'discard') {
        throw new Error('Invalid memory fork completion action')
    }
    const fileSystem = options.fileSystem ?? nodeFs
    const destination = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.characterId,
        input.destinationChatId
    )
    await ensureSafeParent(
        fileSystem,
        input.userDataDirectory,
        dirname(destination.directory)
    )
    const receiptPath = completionReceiptPath(
        destination.directory,
        input.forkToken
    )
    let receipt: Record<string, unknown> | undefined
    try {
        const parsed: unknown = JSON.parse(await fileSystem.readFile(
            receiptPath,
            'utf8'
        ))
        if (!isRecord(parsed)
            || parsed.destinationChatId !== input.destinationChatId
            || parsed.forkToken !== input.forkToken
            || parsed.action !== input.action
            || typeof parsed.completed !== 'boolean') {
            throw new Error('Memory fork completion token/action does not match')
        }
        receipt = parsed
        if (receipt.completed) {
            return { action: input.action, completed: true }
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const staging = replacementStagingPath(
        destination.directory,
        input.forkToken
    )
    if (await exists(fileSystem, destination.directory)) {
        const destinationStatus = await fileSystem.lstat(destination.directory)
        if (destinationStatus.isSymbolicLink()
            || !destinationStatus.isDirectory()) {
            throw new Error('Memory fork destination workspace is unsafe')
        }
    }
    const destinationMarker = join(destination.directory, FORK_MARKER)
    const stagingMarker = join(staging, FORK_MARKER)
    let markerPath = await exists(fileSystem, stagingMarker)
        ? stagingMarker
        : destinationMarker
    if (!await exists(fileSystem, markerPath)) {
        if (receipt) {
            await fileSystem.writeFile(receiptPath, JSON.stringify({
                ...receipt,
                completed: true,
            }), 'utf8')
            return { action: input.action, completed: true }
        }
        throw new Error('Memory fork marker is missing')
    }
    const markerStatus = await fileSystem.lstat(markerPath)
    if (markerStatus.isSymbolicLink() || !markerStatus.isFile()) {
        throw new Error('Memory fork marker is unsafe')
    }
    const markerText = await fileSystem.readFile(markerPath, 'utf8')
    let marker: unknown
    try {
        marker = JSON.parse(markerText)
    }
    catch {
        throw new Error('Memory fork marker is invalid')
    }
    const replacement = isRecord(marker) && marker.replacement === true
    const expectedKeys = replacement
        ? ['destinationChatId', 'forkToken', 'replacement', 'hadDestination']
        : ['destinationChatId', 'forkToken']
    if (!isRecord(marker)
        || Object.keys(marker).length !== expectedKeys.length
        || !expectedKeys.every((key) => Object.hasOwn(marker, key))
        || marker.destinationChatId !== input.destinationChatId
        || marker.forkToken !== input.forkToken
        || (replacement && typeof marker.hadDestination !== 'boolean')) {
        throw new Error('Memory fork token does not match')
    }
    if (replacement) {
        const backup = replacementBackupPath(
            destination.directory,
            input.forkToken
        )
        await fileSystem.writeFile(receiptPath, JSON.stringify({
            destinationChatId: input.destinationChatId,
            forkToken: input.forkToken,
            action: input.action,
            completed: false,
        }), 'utf8')
        if (input.action === 'finalize') {
            if (markerPath === stagingMarker) {
                if (marker.hadDestination
                    && !await exists(fileSystem, backup)) {
                    await fileSystem.rename(destination.directory, backup)
                }
                await fileSystem.rename(staging, destination.directory)
                markerPath = destinationMarker
            }
            await fileSystem.rm(markerPath, { force: false })
            await fileSystem.writeFile(receiptPath, JSON.stringify({
                destinationChatId: input.destinationChatId,
                forkToken: input.forkToken,
                action: input.action,
                completed: true,
            }), 'utf8')
            if (marker.hadDestination) {
                await fileSystem.rm(backup, { recursive: true, force: false })
                    .catch(() => undefined)
            }
        }
        else {
            if (markerPath === stagingMarker) {
                await fileSystem.rm(staging, { recursive: true, force: false })
            }
            else if (marker.hadDestination) {
                const displaced = `${destination.directory}.discard-${randomUUID()}`
                await fileSystem.rename(destination.directory, displaced)
                try {
                    await fileSystem.rename(backup, destination.directory)
                }
                catch (error) {
                    await fileSystem.rename(displaced, destination.directory)
                        .catch(() => undefined)
                    throw error
                }
                await fileSystem.rm(displaced, { recursive: true, force: false })
            }
            else {
                await fileSystem.rm(destination.directory, {
                    recursive: true,
                    force: false,
                })
            }
            await fileSystem.writeFile(receiptPath, JSON.stringify({
                destinationChatId: input.destinationChatId,
                forkToken: input.forkToken,
                action: input.action,
                completed: true,
            }), 'utf8')
        }
        return { action: input.action, completed: true }
    }
    await fileSystem.writeFile(receiptPath, JSON.stringify({
        destinationChatId: input.destinationChatId,
        forkToken: input.forkToken,
        action: input.action,
        completed: false,
    }), 'utf8')
    if (input.action === 'discard') {
        await fileSystem.rm(destination.directory, {
            recursive: true,
            force: false,
        })
    }
    else {
        await fileSystem.rm(markerPath, { force: false })
    }
    await fileSystem.writeFile(receiptPath, JSON.stringify({
        destinationChatId: input.destinationChatId,
        forkToken: input.forkToken,
        action: input.action,
        completed: true,
    }), 'utf8')
    return { action: input.action, completed: true }
}
