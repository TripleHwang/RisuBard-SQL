import * as nodeFs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { inquireMarkdownDocuments } from './risubard-markdown-inquiry'

export interface MarkdownWikiDocument {
    id: string
    type: MarkdownWikiDocumentType
    status: 'active' | 'superseded' | 'retracted'
    supersededBy?: string
    title: string
    relativePath: string
    sourceMessageIds: string[]
    updated: string
    content: string
    links: string[]
    created?: string
    authoring?: 'automatic' | 'ai-assisted' | 'manual'
    contextMode: MarkdownWikiContextMode
    contentHash: string
    reviewStatus?: 'unreviewed' | 'reviewed'
    reviewBaseContent?: string
}

export type MarkdownWikiContextMode = 'always' | 'auto' | 'never'

export type MarkdownWikiDocumentType = 'event' | 'character' | 'location'
    | 'scene' | 'faction' | 'item' | 'concept' | 'other'
export type CanonicalMarkdownWikiDocumentType = Exclude<
    MarkdownWikiDocumentType,
    'event'
>

export interface MarkdownWikiView {
    mode: 'markdown'
    wikiPath: string
    documents: MarkdownWikiDocument[]
    health: MarkdownWikiHealth
}

export interface MarkdownWikiHealth {
    danglingLinks: Array<{ sourceId: string; target: string }>
    unlinkedDocumentIds: string[]
}

export interface CanonicalTurnReceiptChange {
    documentId: string
    type: CanonicalMarkdownWikiDocumentType
    title: string
    relativePath: string
    action: 'create' | 'update'
    beforeHash: string | null
    afterHash: string
    undoneAt?: string
    undoConflict?: 'changed-after-turn' | 'missing-after-turn'
}

export interface CanonicalTurnReceipt {
    snapshotId: string
    sourceMessageIds: string[]
    eventIds: string[]
    changes: CanonicalTurnReceiptChange[]
    warnings: string[]
    recordedAt: string
    undoneAt?: string
}

interface TurnSnapshotManifest {
    snapshotId: string
    created: string
    sourceMessageIds: string[]
    documents: Array<{
        id: string
        type: MarkdownWikiDocumentType
        relativePath: string
        updated: string
        contentHash?: string
    }>
    receipt?: CanonicalTurnReceipt
}

export interface MarkdownWikiWorkspace {
    directory: string
    eventsDirectory: string
    charactersDirectory: string
    locationsDirectory: string
    historyDirectory: string
    trashDirectory: string
    snapshotsDirectory: string
    reviewDirectory: string
    sceneFile: string
    indexFile: string
}

type WikiFileSystem = Pick<
    typeof nodeFs,
    'mkdir' | 'readFile' | 'readdir' | 'rename' | 'rm' | 'writeFile'
>

function required(value: string, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function yamlString(value: string): string {
    return JSON.stringify(value)
}

function stableId(sourceMessageIds: readonly string[]): string {
    return createHash('sha256')
        .update(JSON.stringify(sourceMessageIds))
        .digest('base64url')
        .slice(0, 24)
}

function readableStem(value: string): string {
    return value.normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 64) || 'entry'
}

function normalizeMarkdown(value: string): { title: string; content: string } {
    let content = required(value, 'Markdown').trim()
        .replace(/^<Thoughts>[\s\S]*?<\/Thoughts>\s*/i, '')
        .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*/i, '')
        .trim()
    if (content.length === 0 || content.length > 12_000) {
        throw new Error('Markdown memory must contain 1-12000 characters')
    }
    if (/^#\s+\S+/m.test(content)) {
        content = content.replace(/^(#{1,5})(?=\s)/gm, '$1#')
    }
    const heading = content.match(/^##\s+(.+)$/m)
    const title = (heading?.[1] ?? '서사 기록').trim().slice(0, 160)
    if (!heading) content = `## ${title}\n\n${content}`
    return { title, content }
}

function linksFrom(content: string): string[] {
    return [...content.matchAll(/\[\[([^\]\r\n]{1,240})\]\]/g)]
        .map((match) => match[1])
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, 32)
}

function appendKnownDocumentLinks(
    content: string,
    documents: readonly MarkdownWikiDocument[],
    selfId: string
): string {
    const existingTargets = new Set(linksFrom(content).map((value) =>
        value.split('|')[0]?.split('#')[0]?.normalize('NFKC')
            .toLocaleLowerCase().trim()
    ))
    const searchable = content.normalize('NFKC').toLocaleLowerCase()
    const related = documents.filter((document) => {
        const title = document.title.normalize('NFKC').toLocaleLowerCase().trim()
        return document.id !== selfId
            && document.status === 'active'
            && title.length > 1
            && !/[\[\]\r\n]/.test(document.title)
            && !existingTargets.has(title)
            && searchable.includes(title)
    }).sort((left, right) =>
        right.title.length - left.title.length
        || left.id.localeCompare(right.id)
    ).slice(0, Math.max(0, 32 - existingTargets.size))
    if (related.length === 0) return content
    const bullets = related.map((document) => `- [[${document.title}]]`)
        .join('\n')
    if (/^###\s+관련 문서\s*$/m.test(content)) {
        return content.replace(
            /^###\s+관련 문서\s*$/m,
            (heading) => `${heading}\n\n${bullets}`
        )
    }
    return `${content}\n\n### 관련 문서\n\n${bullets}`
}

function removeCharacterEventLinksFromRelatedDocuments(
    content: string,
    documents: readonly MarkdownWikiDocument[]
): string {
    const eventTitles = new Set(documents
        .filter((document) => document.type === 'event')
        .map((document) => document.title.normalize('NFKC')
            .toLocaleLowerCase().trim()))
    if (eventTitles.size === 0) return content
    let inRelatedDocuments = false
    const filtered = content.split(/\r?\n/).filter((line) => {
        const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/)
        if (heading) {
            if (heading[1].length <= 3) {
                inRelatedDocuments = heading[1].length === 3
                    && heading[2].normalize('NFKC').trim() === '관련 문서'
            }
            return true
        }
        if (!inRelatedDocuments) return true
        const bullet = line.match(/^\s*[-*+]\s+\[\[([^\]|#]+)(?:[^\]]*)\]\]\s*$/)
        if (!bullet) return true
        return !eventTitles.has(bullet[1].normalize('NFKC')
            .toLocaleLowerCase().trim())
    })
    const relatedHeading = filtered.findIndex((line) =>
        /^###\s+관련 문서\s*$/.test(line))
    if (relatedHeading >= 0) {
        const nextSection = filtered.findIndex((line, index) =>
            index > relatedHeading && /^#{1,3}\s+\S/.test(line))
        const sectionEnd = nextSection >= 0 ? nextSection : filtered.length
        if (filtered.slice(relatedHeading + 1, sectionEnd)
            .every((line) => line.trim().length === 0)) {
            filtered.splice(relatedHeading, sectionEnd - relatedHeading)
        }
    }
    return filtered.join('\n').trim()
}

function hashDocumentBytes(contents: string): string {
    return createHash('sha256').update(contents).digest('base64url')
}

function prepareDocument(
    document: Omit<MarkdownWikiDocument, 'contentHash'>
): { document: MarkdownWikiDocument; contents: string } {
    const contents = serializeDocument(document)
    return {
        document: { ...document, contentHash: hashDocumentBytes(contents) },
        contents,
    }
}

function serializeDocument(
    document: Omit<MarkdownWikiDocument, 'contentHash'>
): string {
    return [
        '---',
        `id: ${yamlString(document.id)}`,
        `type: ${document.type}`,
        `status: ${document.status}`,
        ...(document.supersededBy
            ? [`superseded_by: ${yamlString(document.supersededBy)}`]
            : []),
        ...(document.created
            ? [`created: ${yamlString(document.created)}`]
            : []),
        `updated: ${yamlString(document.updated)}`,
        ...(document.authoring
            ? [`authoring: ${document.authoring}`]
            : []),
        ...(document.reviewStatus
            ? [`review_status: ${document.reviewStatus}`]
            : []),
        `context: ${document.contextMode}`,
        'source_messages:',
        ...document.sourceMessageIds.map((id) => `  - ${yamlString(id)}`),
        'links:',
        ...document.links.map((link) => `  - ${yamlString(link)}`),
        '---',
        '',
        document.content,
        '',
    ].join('\n')
}

function parseDocument(
    contents: string,
    relativePath: string
): MarkdownWikiDocument {
    const boundary = contents.indexOf('\n---\n', 4)
    if (!contents.startsWith('---\n') || boundary < 0) {
        throw new Error('Invalid Markdown wiki frontmatter')
    }
    const frontmatter = contents.slice(4, boundary)
    const storedContent = contents.slice(boundary + 5).trim()
    const scalar = (key: string): string => {
        const match = frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))
        if (!match) throw new Error(`Missing Markdown wiki ${key}`)
        return JSON.parse(match[1])
    }
    const plainScalar = (key: string): string => {
        const match = frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))
        if (!match) throw new Error(`Missing Markdown wiki ${key}`)
        return match[1].trim()
    }
    const list = (key: string): string[] => {
        const match = frontmatter.match(
            new RegExp(`^${key}:\\n((?:  - .+\\n?)*)`, 'm')
        )
        if (!match) return []
        return match[1].trim().length === 0
            ? []
            : match[1].trim().split('\n').map((line) =>
                JSON.parse(line.trim().replace(/^-\s+/, ''))
            )
    }
    const storedTitle = storedContent.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim()
    const normalized = normalizeMarkdown(storedContent)
    const type = plainScalar('type')
    if (![
        'event', 'character', 'location', 'scene', 'faction', 'item',
        'concept', 'other',
    ].includes(type)) {
        throw new Error('Invalid Markdown wiki type')
    }
    const optionalScalar = (key: string): string | undefined => {
        const match = frontmatter.match(new RegExp(`^${key}: (.+)$`, 'm'))
        if (!match) return undefined
        try { return JSON.parse(match[1]) }
        catch { return match[1].trim() }
    }
    const updated = scalar('updated')
    const authoring = optionalScalar('authoring')
    const context = optionalScalar('context')
    const reviewStatus = optionalScalar('review_status')
    if (reviewStatus !== undefined
        && reviewStatus !== 'unreviewed'
        && reviewStatus !== 'reviewed') {
        throw new Error('Invalid Markdown wiki review status')
    }
    const defaultContext: MarkdownWikiContextMode = type === 'scene'
        ? 'always'
        : 'auto'
    const status = plainScalar('status')
    if (status !== 'active'
        && status !== 'superseded'
        && status !== 'retracted') {
        throw new Error('Invalid Markdown wiki status')
    }
    return {
        id: scalar('id'),
        type: type as MarkdownWikiDocument['type'],
        status,
        ...(status === 'superseded'
            ? { supersededBy: required(
                optionalScalar('superseded_by') ?? '',
                'Markdown wiki supersededBy'
            ) }
            : {}),
        title: required(storedTitle ?? '', 'Markdown wiki title'),
        relativePath,
        sourceMessageIds: list('source_messages'),
        updated,
        content: normalized.content,
        links: list('links'),
        created: optionalScalar('created') ?? updated,
        authoring: (['automatic', 'ai-assisted', 'manual'].includes(
            authoring ?? ''
        ) ? authoring : type === 'event' ? 'automatic' : 'ai-assisted') as
            MarkdownWikiDocument['authoring'],
        contextMode: (['always', 'auto', 'never'].includes(context ?? '')
            ? context
            : defaultContext) as MarkdownWikiContextMode,
        contentHash: hashDocumentBytes(contents),
        ...(reviewStatus ? {
            reviewStatus: reviewStatus as 'unreviewed' | 'reviewed',
        } : {}),
    }
}

function computeHealth(documents: MarkdownWikiDocument[]): MarkdownWikiHealth {
    const byTarget = new Map<string, MarkdownWikiDocument>()
    for (const document of documents) {
        const pathWithoutExtension = document.relativePath.replace(/\.md$/i, '')
        const fileName = basename(pathWithoutExtension)
        for (const value of [document.title, pathWithoutExtension, fileName]) {
            byTarget.set(value.normalize('NFKC').toLocaleLowerCase(), document)
        }
    }
    const connected = new Set<string>()
    const danglingLinks: MarkdownWikiHealth['danglingLinks'] = []
    for (const document of documents) {
        for (const rawLink of document.links) {
            const target = rawLink.split('|')[0]?.split('#')[0]?.trim() ?? ''
            if (!target) continue
            const resolved = byTarget.get(
                target.normalize('NFKC').toLocaleLowerCase()
            )
            if (!resolved) {
                if (danglingLinks.length < 64) {
                    danglingLinks.push({ sourceId: document.id, target })
                }
                continue
            }
            if (resolved.id === document.id) continue
            connected.add(document.id)
            connected.add(resolved.id)
        }
    }
    return {
        danglingLinks,
        unlinkedDocumentIds: documents
            .filter((document) => document.type !== 'event'
                && document.type !== 'scene'
                && !connected.has(document.id))
            .map((document) => document.id)
            .sort()
            .slice(0, 64),
    }
}

async function writeAtomically(
    fileSystem: WikiFileSystem,
    file: string,
    contents: string
): Promise<void> {
    const temporary = `${file}.tmp-${randomUUID()}`
    try {
        await fileSystem.writeFile(temporary, contents, {
            encoding: 'utf8',
            flag: 'wx',
            mode: 0o600,
        })
        await fileSystem.rename(temporary, file)
    }
    catch (error) {
        await fileSystem.rm(temporary, { force: true }).catch(() => undefined)
        throw error
    }
}

export function resolveMarkdownWikiWorkspace(
    userDataDirectory: string,
    characterId: string,
    chatId: string
): MarkdownWikiWorkspace {
    if (!isAbsolute(required(userDataDirectory, 'userDataDirectory'))) {
        throw new Error('userDataDirectory must be absolute')
    }
    const memory = resolveMemoryWorkspace(
        userDataDirectory,
        characterId,
        chatId
    )
    const directory = resolve(memory.directory, 'wiki')
    return {
        directory,
        eventsDirectory: resolve(directory, 'events'),
        charactersDirectory: resolve(directory, 'characters'),
        locationsDirectory: resolve(directory, 'locations'),
        historyDirectory: resolve(directory, '.risubard-history'),
        trashDirectory: resolve(directory, '.risubard-trash'),
        snapshotsDirectory: resolve(directory, '.risubard-snapshots'),
        reviewDirectory: resolve(directory, '.risubard-review'),
        sceneFile: resolve(directory, 'current-scene.md'),
        indexFile: resolve(directory, 'index.md'),
    }
}

export function createMarkdownNarrativeWiki(
    userDataDirectory: string,
    options: {
        fileSystem?: WikiFileSystem
        now?: () => Date
    } = {}
) {
    const fileSystem = options.fileSystem ?? nodeFs
    const now = options.now ?? (() => new Date())
    const workspaceFor = (characterId: string, chatId: string) =>
        resolveMarkdownWikiWorkspace(userDataDirectory, characterId, chatId)
    const documentCache = new Map<string, MarkdownWikiDocument[]>()

    const readDocuments = async (
        characterId: string,
        chatId: string
    ): Promise<MarkdownWikiDocument[]> => {
        const workspace = workspaceFor(characterId, chatId)
        const documents: MarkdownWikiDocument[] = []
        const folders = [
            [workspace.charactersDirectory, 'characters'],
            [workspace.locationsDirectory, 'locations'],
            [resolve(workspace.directory, 'factions'), 'factions'],
            [resolve(workspace.directory, 'items'), 'items'],
            [resolve(workspace.directory, 'concepts'), 'concepts'],
            [resolve(workspace.directory, 'notes'), 'notes'],
            [workspace.eventsDirectory, 'events'],
        ] as const
        try {
            documents.push(parseDocument(
                await fileSystem.readFile(workspace.sceneFile, 'utf8'),
                'current-scene.md'
            ))
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        for (const [directory, prefix] of folders) {
            let files: string[]
            try {
                files = (await fileSystem.readdir(directory))
                    .filter((file) => file.endsWith('.md'))
                    .sort()
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
                throw error
            }
            const loaded = await Promise.all(files.map(async (file) => ({
                file: join(directory, basename(file)),
                document: parseDocument(
                    await fileSystem.readFile(
                        join(directory, basename(file)),
                        'utf8'
                    ),
                    `${prefix}/${file}`
                ),
            })))
            for (const item of loaded) {
                if (item.document.type === 'event'
                    && item.document.status === 'retracted') {
                    await fileSystem.rm(item.file, { force: true })
                    continue
                }
                documents.push(item.document)
            }
        }
        return documents
    }

    const refreshDocuments = async (
        characterId: string,
        chatId: string
    ): Promise<MarkdownWikiDocument[]> => {
        const documents = await readDocuments(characterId, chatId)
        documentCache.set(workspaceFor(characterId, chatId).directory, documents)
        return documents
    }

    const loadDocuments = async (
        characterId: string,
        chatId: string
    ): Promise<MarkdownWikiDocument[]> => {
        const key = workspaceFor(characterId, chatId).directory
        return documentCache.get(key)
            ?? refreshDocuments(characterId, chatId)
    }

    const rebuildIndex = async (
        characterId: string,
        chatId: string
    ): Promise<void> => {
        const workspace = workspaceFor(characterId, chatId)
        const documents = await refreshDocuments(characterId, chatId)
        const index = [
            '---',
            'type: narrative_wiki_index',
            'status: active',
            '---',
            '',
            '## 서사 위키',
            '',
            ...documents.map((item) =>
                `- [[${item.relativePath.replace(/\.md$/, '')}|${item.title}]]`
            ),
            '',
        ].join('\n')
        await writeAtomically(fileSystem, workspace.indexFile, index)
    }

    return {
        invalidateCache(characterId: string, chatId: string): void {
            documentCache.delete(workspaceFor(characterId, chatId).directory)
        },
        async recoverRebootBatch(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
            eventSourceGroups: string[][]
        }): Promise<CanonicalTurnReceipt | null> {
            const sourceMessageIds = input.sourceMessageIds.map((id) =>
                required(id, 'Source message ID')
            )
            if (sourceMessageIds.length < 1 || sourceMessageIds.length > 12
                || input.eventSourceGroups.length < 1
                || input.eventSourceGroups.length > 2) {
                throw new Error('Invalid reboot recovery sources')
            }
            const eventSourceGroups = input.eventSourceGroups.map((group) => {
                const normalized = group.map((id) =>
                    required(id, 'Event source message ID')
                )
                if (normalized.length < 1 || normalized.length > 2) {
                    throw new Error('Invalid reboot event source group')
                }
                return normalized
            })
            const workspace = workspaceFor(input.characterId, input.chatId)
            const snapshotId = `turn-${stableId(sourceMessageIds)}`
            const snapshotDirectory = join(
                workspace.snapshotsDirectory,
                snapshotId
            )
            const manifestFile = join(snapshotDirectory, 'manifest.json')
            let manifest: TurnSnapshotManifest
            try {
                manifest = JSON.parse(await fileSystem.readFile(
                    manifestFile,
                    'utf8'
                )) as TurnSnapshotManifest
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
                throw error
            }
            if (manifest.snapshotId !== snapshotId
                || JSON.stringify(manifest.sourceMessageIds)
                    !== JSON.stringify(sourceMessageIds)
                || !Array.isArray(manifest.documents)) {
                throw new Error('Wiki reboot snapshot is invalid')
            }
            if (manifest.receipt?.snapshotId === snapshotId) {
                return manifest.receipt
            }
            const current = await loadDocuments(
                input.characterId,
                input.chatId
            )
            const baselineCanonical = new Map(manifest.documents
                .filter((document) => document.type !== 'event')
                .map((document) => [document.id, document]))
            const exactEventSources = new Set(eventSourceGroups.map((group) =>
                JSON.stringify(group)
            ))
            for (const document of current) {
                const removeEvent = document.type === 'event'
                    && exactEventSources.has(JSON.stringify(
                        document.sourceMessageIds
                    ))
                const removeCreatedCanonical = document.type !== 'event'
                    && !baselineCanonical.has(document.id)
                const baseline = baselineCanonical.get(document.id)
                const removeMovedCanonical = Boolean(baseline
                    && baseline.relativePath !== document.relativePath)
                if (removeEvent || removeCreatedCanonical
                    || removeMovedCanonical) {
                    await fileSystem.rm(join(
                        workspace.directory,
                        ...document.relativePath.split('/')
                    ), { force: true })
                }
            }
            for (const document of baselineCanonical.values()) {
                const source = join(
                    snapshotDirectory,
                    ...document.relativePath.split('/')
                )
                const target = join(
                    workspace.directory,
                    ...document.relativePath.split('/')
                )
                await fileSystem.mkdir(resolve(target, '..'), {
                    recursive: true,
                })
                await writeAtomically(
                    fileSystem,
                    target,
                    await fileSystem.readFile(source, 'utf8')
                )
            }
            await rebuildIndex(input.characterId, input.chatId)
            return null
        },
        async snapshotBeforeTurn(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
        }): Promise<{ snapshotId: string; canonicalCount: number }> {
            const sourceMessageIds = input.sourceMessageIds.map((id) =>
                required(id, 'sourceMessageId')
            )
            if (sourceMessageIds.length === 0 || sourceMessageIds.length > 12) {
                throw new Error('Wiki snapshot requires 1-12 sources')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const documents = await loadDocuments(input.characterId, input.chatId)
            const canonical = documents.filter((document) =>
                document.type !== 'event'
            )
            const snapshotId = `turn-${stableId(sourceMessageIds)}`
            const snapshotDirectory = join(
                workspace.snapshotsDirectory,
                snapshotId
            )
            const manifestFile = join(snapshotDirectory, 'manifest.json')
            try {
                const manifest = JSON.parse(await fileSystem.readFile(
                    manifestFile,
                    'utf8'
                )) as {
                    snapshotId?: unknown
                    sourceMessageIds?: unknown
                    documents?: unknown
                }
                if (manifest.snapshotId !== snapshotId
                    || JSON.stringify(manifest.sourceMessageIds)
                        !== JSON.stringify(sourceMessageIds)
                    || !Array.isArray(manifest.documents)) {
                    throw new Error('Existing wiki snapshot manifest is invalid')
                }
                return {
                    snapshotId,
                    canonicalCount: manifest.documents.filter((document) =>
                        typeof document === 'object'
                        && document !== null
                        && (document as { type?: unknown }).type !== 'event'
                    ).length,
                }
            }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw error
                }
            }
            await fileSystem.rm(snapshotDirectory, {
                recursive: true,
                force: true,
            })
            await fileSystem.mkdir(snapshotDirectory, { recursive: true })
            for (const document of canonical) {
                const target = join(
                    snapshotDirectory,
                    ...document.relativePath.split('/')
                )
                await fileSystem.mkdir(resolve(target, '..'), {
                    recursive: true,
                })
                await writeAtomically(
                    fileSystem,
                    target,
                    await fileSystem.readFile(join(
                        workspace.directory,
                        ...document.relativePath.split('/')
                    ), 'utf8')
                )
            }
            await writeAtomically(
                fileSystem,
                manifestFile,
                `${JSON.stringify({
                    snapshotId,
                    created: now().toISOString(),
                    sourceMessageIds,
                    documents: documents.map((document) => ({
                        id: document.id,
                        type: document.type,
                        relativePath: document.relativePath,
                        updated: document.updated,
                        contentHash: document.contentHash,
                    })),
                }, null, 2)}\n`
            )
            return { snapshotId, canonicalCount: canonical.length }
        },

        async recordTurnReceipt(input: {
            characterId: string
            chatId: string
            snapshotId: string
            sourceMessageIds: string[]
            eventId?: string
            changes: Array<{
                documentId: string
                type: CanonicalMarkdownWikiDocumentType
                title: string
                relativePath: string
                afterHash: string
            }>
            warnings: string[]
        }): Promise<CanonicalTurnReceipt> {
            const sourceMessageIds = input.sourceMessageIds.map((id) =>
                required(id, 'Source message ID')
            )
            const expectedSnapshotId = `turn-${stableId(sourceMessageIds)}`
            if (required(input.snapshotId, 'Snapshot ID') !== expectedSnapshotId) {
                throw new Error('Wiki turn receipt snapshot does not match sources')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const manifestFile = join(
                workspace.snapshotsDirectory,
                input.snapshotId,
                'manifest.json'
            )
            const manifest = JSON.parse(await fileSystem.readFile(
                manifestFile,
                'utf8'
            )) as TurnSnapshotManifest
            if (manifest.snapshotId !== input.snapshotId
                || JSON.stringify(manifest.sourceMessageIds)
                    !== JSON.stringify(sourceMessageIds)
                || !Array.isArray(manifest.documents)) {
                throw new Error('Wiki turn receipt snapshot is invalid')
            }
            const previous = manifest.receipt
            const byId = new Map(
                (previous?.changes ?? []).map((change) => [
                    change.documentId,
                    change,
                ])
            )
            for (const change of input.changes.slice(0, 8)) {
                const documentId = required(change.documentId, 'Document ID')
                const baseline = manifest.documents.find((document) =>
                    document.id === documentId && document.type !== 'event'
                )
                const prior = byId.get(documentId)
                byId.set(documentId, {
                    documentId,
                    type: change.type,
                    title: required(change.title, 'Title').slice(0, 160),
                    relativePath: required(
                        change.relativePath,
                        'Relative path'
                    ),
                    action: prior?.action ?? (baseline ? 'update' : 'create'),
                    beforeHash: prior?.beforeHash
                        ?? baseline?.contentHash
                        ?? null,
                    afterHash: required(change.afterHash, 'Content hash'),
                })
            }
            const receipt: CanonicalTurnReceipt = {
                snapshotId: input.snapshotId,
                sourceMessageIds,
                eventIds: [...new Set([
                    ...(previous?.eventIds ?? []),
                    ...(input.eventId ? [required(input.eventId, 'Event ID')] : []),
                ])],
                changes: [...byId.values()],
                warnings: [...new Set([
                    ...(previous?.warnings ?? []),
                    ...input.warnings.map((warning) =>
                        required(warning, 'Receipt warning').slice(0, 500)
                    ),
                ])].slice(0, 32),
                recordedAt: previous?.recordedAt ?? now().toISOString(),
            }
            manifest.receipt = receipt
            await writeAtomically(
                fileSystem,
                manifestFile,
                `${JSON.stringify(manifest, null, 2)}\n`
            )
            return receipt
        },

        async undoTurnReceipt(input: {
            characterId: string
            chatId: string
            snapshotId: string
            documentId?: string
        }): Promise<CanonicalTurnReceipt> {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const snapshotDirectory = join(
                workspace.snapshotsDirectory,
                required(input.snapshotId, 'Snapshot ID')
            )
            const manifestFile = join(snapshotDirectory, 'manifest.json')
            const manifest = JSON.parse(await fileSystem.readFile(
                manifestFile,
                'utf8'
            )) as TurnSnapshotManifest
            const receipt = manifest.receipt
            if (!receipt || receipt.snapshotId !== input.snapshotId) {
                throw new Error('Wiki turn receipt does not exist')
            }
            const selected = receipt.changes.filter((change) =>
                !change.undoneAt
                && (!input.documentId || change.documentId === input.documentId)
            )
            if (input.documentId && selected.length !== 1) {
                throw new Error('Wiki turn receipt document is not undoable')
            }
            const current = await loadDocuments(input.characterId, input.chatId)
            const undoable: Array<{
                change: CanonicalTurnReceiptChange
                document: MarkdownWikiDocument
            }> = []
            for (const change of selected) {
                const document = current.find((item) =>
                    item.id === change.documentId
                )
                if (!document || document.contentHash !== change.afterHash) {
                    if (input.documentId) {
                        throw new Error(
                            'Wiki document changed after this turn; undo conflict'
                        )
                    }
                    change.undoConflict = document
                        ? 'changed-after-turn'
                        : 'missing-after-turn'
                    continue
                }
                delete change.undoConflict
                undoable.push({ change, document })
            }
            const operationTime = now().toISOString()
            for (const { change, document } of undoable) {
                const file = join(
                    workspace.directory,
                    ...document.relativePath.split('/')
                )
                if (change.action === 'create') {
                    const trash = join(workspace.trashDirectory, document.id)
                    await fileSystem.mkdir(trash, { recursive: true })
                    await writeAtomically(
                        fileSystem,
                        join(
                            trash,
                            `${operationTime.replace(/[:.]/g, '-')}-${basename(file)}`
                        ),
                        await fileSystem.readFile(file, 'utf8')
                    )
                    await fileSystem.rm(file)
                }
                else {
                    const baseline = manifest.documents.find((item) =>
                        item.id === change.documentId
                    )
                    if (!baseline) {
                        throw new Error('Wiki turn snapshot baseline is missing')
                    }
                    await writeAtomically(
                        fileSystem,
                        file,
                        await fileSystem.readFile(join(
                            snapshotDirectory,
                            ...baseline.relativePath.split('/')
                        ), 'utf8')
                    )
                }
                change.undoneAt = operationTime
            }
            if (!input.documentId) {
                for (const eventId of receipt.eventIds) {
                    const event = current.find((document) =>
                        document.id === eventId
                    )
                    if (!event || event.type !== 'event'
                        || event.status !== 'active') continue
                    await fileSystem.rm(
                        join(
                            workspace.directory,
                            ...event.relativePath.split('/')
                        ),
                        { force: true }
                    )
                }
                receipt.undoneAt = operationTime
            }
            manifest.receipt = receipt
            await writeAtomically(
                fileSystem,
                manifestFile,
                `${JSON.stringify(manifest, null, 2)}\n`
            )
            await rebuildIndex(input.characterId, input.chatId)
            return receipt
        },

        async resolveDocumentFile(input: {
            characterId: string
            chatId: string
            documentId: string
        }): Promise<string> {
            const document = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === input.documentId)
            if (!document) throw new Error('Wiki document does not exist')
            const workspace = workspaceFor(input.characterId, input.chatId)
            return join(
                workspace.directory,
                ...document.relativePath.split('/')
            )
        },

        async saveConfirmedTurn(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
            markdown: string
            append?: boolean
        }): Promise<MarkdownWikiDocument> {
            const sourceMessageIds = input.sourceMessageIds.map((id) =>
                required(id, 'sourceMessageId')
            )
            if (sourceMessageIds.length === 0 || sourceMessageIds.length > 12) {
                throw new Error('Markdown memory requires 1-12 sources')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            await fileSystem.mkdir(workspace.eventsDirectory, {
                recursive: true,
            })
            const knownDocuments = await loadDocuments(
                input.characterId,
                input.chatId
            )
            let normalized = normalizeMarkdown(input.markdown)
            const suffix = stableId(sourceMessageIds)
            const file = `turn-${suffix}.md`
            const operationTime = now().toISOString()
            const existingEvent = input.append
                ? (await loadDocuments(input.characterId, input.chatId))
                    .find((document) => document.id === `event.${suffix}`)
                : undefined
            if (existingEvent?.type === 'event') {
                const addition = normalized.content.replace(
                    /^##\s+[^\r\n]+\r?\n*/,
                    ''
                ).trim()
                normalized = normalizeMarkdown([
                    existingEvent.content,
                    '### 추가 분석',
                    addition,
                ].filter(Boolean).join('\n\n'))
            }
            normalized = normalizeMarkdown(appendKnownDocumentLinks(
                normalized.content,
                knownDocuments,
                `event.${suffix}`
            ))
            const prepared = prepareDocument({
                id: `event.${suffix}`,
                type: 'event',
                status: 'active',
                title: normalized.title,
                relativePath: `events/${file}`,
                sourceMessageIds,
                updated: operationTime,
                content: normalized.content,
                links: linksFrom(normalized.content),
                created: existingEvent?.created ?? operationTime,
                authoring: 'automatic',
                contextMode: 'auto',
            })
            await writeAtomically(
                fileSystem,
                join(workspace.eventsDirectory, file),
                prepared.contents
            )
            await rebuildIndex(input.characterId, input.chatId)
            return prepared.document
        },

        async saveCanonicalDocument(input: {
            characterId: string
            chatId: string
            documentId?: string
            type: CanonicalMarkdownWikiDocumentType
            title: string
            sourceMessageIds: string[]
            markdown: string
            expectedContentHash?: string
            reviewStatus?: 'unreviewed' | 'reviewed'
        }): Promise<MarkdownWikiDocument> {
            const title = required(input.title, 'Title').trim().slice(0, 160)
            const incomingSources = input.sourceMessageIds.map((id) =>
                required(id, 'sourceMessageId')
            )
            if (incomingSources.length === 0 || incomingSources.length > 12) {
                throw new Error('Canonical wiki document requires 1-12 sources')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const documents = await loadDocuments(
                input.characterId,
                input.chatId
            )
            const existing = input.documentId
                ? documents.find((document) =>
                    document.id === input.documentId)
                : undefined
            if (input.documentId && !existing) {
                throw new Error('Canonical wiki document does not exist')
            }
            if (existing && existing.type !== input.type) {
                throw new Error('Canonical wiki document type cannot change')
            }
            if (existing && input.expectedContentHash
                && existing.contentHash !== input.expectedContentHash) {
                throw new Error(
                    'Wiki document changed since the draft was created'
                )
            }
            const suffix = existing?.id.split('.').at(-1)
                ?? stableId([input.type, title.normalize('NFKC').toLocaleLowerCase()])
            const id = existing?.id ?? `${input.type}.${suffix}`
            const folder: Record<CanonicalMarkdownWikiDocumentType, string> = {
                character: 'characters',
                location: 'locations',
                scene: '',
                faction: 'factions',
                item: 'items',
                concept: 'concepts',
                other: 'notes',
            }
            const relativePath = existing?.relativePath
                ?? (input.type === 'scene'
                    ? 'current-scene.md'
                    : `${folder[input.type]}/${readableStem(title)}-${suffix}.md`)
            const file = input.type === 'scene'
                ? workspace.sceneFile
                : join(workspace.directory, ...relativePath.split('/'))
            const operationTime = now().toISOString()
            await fileSystem.mkdir(resolve(file, '..'), { recursive: true })
            const reviewFile = join(
                workspace.reviewDirectory,
                `${stableId([id])}.md`
            )
            if (input.reviewStatus === 'unreviewed'
                && existing?.reviewStatus !== 'unreviewed') {
                await fileSystem.mkdir(workspace.reviewDirectory, {
                    recursive: true,
                })
                await writeAtomically(
                    fileSystem,
                    reviewFile,
                    existing ? await fileSystem.readFile(file, 'utf8') : ''
                )
            }
            if (existing) {
                const history = join(workspace.historyDirectory, existing.id)
                await fileSystem.mkdir(history, { recursive: true })
                const stamp = operationTime.replace(/[:.]/g, '-')
                await writeAtomically(
                    fileSystem,
                    join(history, `${stamp}-${randomUUID().slice(0, 8)}.md`),
                    await fileSystem.readFile(file, 'utf8')
                )
            }
            let normalized = normalizeMarkdown(input.markdown)
            if (input.type === 'character') {
                normalized = normalizeMarkdown(
                    removeCharacterEventLinksFromRelatedDocuments(
                        normalized.content,
                        documents
                    )
                )
            }
            normalized = normalizeMarkdown(appendKnownDocumentLinks(
                normalized.content,
                input.type === 'character'
                    ? documents.filter((document) => document.type !== 'event')
                    : documents,
                id
            ))
            const prepared = prepareDocument({
                id,
                type: input.type,
                status: 'active',
                title: normalized.title,
                relativePath,
                sourceMessageIds: [...new Set([
                    ...(existing?.sourceMessageIds ?? []),
                    ...incomingSources,
                ])].slice(-96),
                updated: operationTime,
                content: normalized.content,
                links: linksFrom(normalized.content),
                created: existing?.created ?? operationTime,
                authoring: 'ai-assisted',
                reviewStatus: input.reviewStatus ?? 'reviewed',
                contextMode: input.type === 'scene'
                    ? 'always'
                    : existing?.contextMode ?? 'auto',
            })
            await writeAtomically(fileSystem, file, prepared.contents)
            await rebuildIndex(input.characterId, input.chatId)
            return prepared.document
        },

        async reviewCanonicalDocument(input: {
            characterId: string
            chatId: string
            documentId: string
            action: 'accept' | 'revert'
            expectedContentHash: string
        }): Promise<MarkdownWikiDocument | {
            id: string
            reverted: true
            deleted: true
        }> {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const document = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === required(
                input.documentId,
                'Document ID'
            ))
            if (!document || document.type === 'event'
                || document.status !== 'active') {
                throw new Error('Canonical wiki document does not exist')
            }
            if (document.reviewStatus !== 'unreviewed') {
                throw new Error('Canonical wiki document is not awaiting review')
            }
            if (document.contentHash !== input.expectedContentHash) {
                throw new Error('Wiki document changed since review opened')
            }
            const file = join(
                workspace.directory,
                ...document.relativePath.split('/')
            )
            const reviewFile = join(
                workspace.reviewDirectory,
                `${stableId([document.id])}.md`
            )
            if (input.action === 'revert') {
                const baseline = await fileSystem.readFile(reviewFile, 'utf8')
                if (baseline.length === 0) {
                    const trash = join(
                        workspace.trashDirectory,
                        document.id
                    )
                    await fileSystem.mkdir(trash, { recursive: true })
                    await writeAtomically(
                        fileSystem,
                        join(trash, `${now().toISOString().replace(/[:.]/g, '-')}-${basename(file)}`),
                        await fileSystem.readFile(file, 'utf8')
                    )
                    await fileSystem.rm(file)
                    await fileSystem.rm(reviewFile, { force: true })
                    await rebuildIndex(input.characterId, input.chatId)
                    return {
                        id: document.id,
                        reverted: true as const,
                        deleted: true as const,
                    }
                }
                const history = join(workspace.historyDirectory, document.id)
                await fileSystem.mkdir(history, { recursive: true })
                await writeAtomically(
                    fileSystem,
                    join(history, `${now().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.md`),
                    await fileSystem.readFile(file, 'utf8')
                )
                await writeAtomically(fileSystem, file, baseline)
            }
            else {
                const { contentHash: _contentHash, reviewBaseContent: _base,
                    ...stored } = document
                const accepted = prepareDocument({
                    ...stored,
                    reviewStatus: 'reviewed',
                    updated: now().toISOString(),
                })
                await writeAtomically(fileSystem, file, accepted.contents)
            }
            await fileSystem.rm(reviewFile, { force: true })
            await rebuildIndex(input.characterId, input.chatId)
            const reviewed = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === document.id)
            if (!reviewed) throw new Error('Reviewed wiki document disappeared')
            return reviewed.reviewStatus
                ? reviewed
                : { ...reviewed, reviewStatus: 'reviewed' }
        },

        async saveManualDocument(input: {
            characterId: string
            chatId: string
            documentId?: string
            type: CanonicalMarkdownWikiDocumentType
            title: string
            markdown: string
            expectedContentHash?: string
        }): Promise<MarkdownWikiDocument> {
            const title = required(input.title, 'Title').trim().slice(0, 160)
            const allowed: CanonicalMarkdownWikiDocumentType[] = [
                'character', 'location', 'scene', 'faction', 'item',
                'concept', 'other',
            ]
            if (!allowed.includes(input.type)) {
                throw new Error('Invalid manual wiki document type')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const documents = await loadDocuments(input.characterId, input.chatId)
            const existing = input.documentId
                ? documents.find((document) => document.id === input.documentId)
                : undefined
            if (input.documentId && !existing) {
                throw new Error('Canonical wiki document does not exist')
            }
            if (existing?.type === 'event') {
                throw new Error('Event documents are read-only')
            }
            if (existing && input.expectedContentHash
                && existing.contentHash !== input.expectedContentHash) {
                throw new Error(
                    'Wiki document changed since the draft was created'
                )
            }
            const operationTime = now().toISOString()
            const suffix = existing?.id.split('.').at(-1)
                ?? stableId([input.type, title, randomUUID()])
            const id = existing?.id ?? `${input.type}.${suffix}`
            const folder: Record<CanonicalMarkdownWikiDocumentType, string> = {
                character: 'characters',
                location: 'locations',
                scene: '',
                faction: 'factions',
                item: 'items',
                concept: 'concepts',
                other: 'notes',
            }
            const relativePath = input.type === 'scene'
                ? 'current-scene.md'
                : `${folder[input.type]}/${readableStem(title)}-${suffix}.md`
            const file = join(workspace.directory, ...relativePath.split('/'))
            const oldFile = existing
                ? join(workspace.directory, ...existing.relativePath.split('/'))
                : undefined
            if (documents.some((item) =>
                item.relativePath === relativePath && item.id !== existing?.id
            )) {
                throw new Error('A wiki document already owns that path')
            }
            await fileSystem.mkdir(resolve(file, '..'), { recursive: true })
            if (existing && oldFile) {
                const history = join(workspace.historyDirectory, existing.id)
                await fileSystem.mkdir(history, { recursive: true })
                const stamp = operationTime.replace(/[:.]/g, '-')
                await writeAtomically(
                    fileSystem,
                    join(history, `${stamp}-${randomUUID().slice(0, 8)}.md`),
                    await fileSystem.readFile(oldFile, 'utf8')
                )
            }
            const normalized = normalizeMarkdown(input.markdown)
            const content = normalized.content.replace(
                /^##\s+.+$/m,
                `## ${title}`
            )
            const prepared = prepareDocument({
                id,
                type: input.type,
                status: 'active',
                title,
                relativePath,
                sourceMessageIds: existing?.sourceMessageIds ?? [],
                created: existing?.created ?? operationTime,
                updated: operationTime,
                authoring: 'manual',
                content,
                links: linksFrom(content),
                contextMode: input.type === 'scene'
                    ? 'always'
                    : existing?.contextMode ?? 'auto',
            })
            await writeAtomically(fileSystem, file, prepared.contents)
            if (oldFile && oldFile !== file) {
                await fileSystem.rm(oldFile)
            }
            if (existing && existing.title !== title) {
                for (const linked of documents) {
                    if (linked.id === existing.id || linked.type === 'event') continue
                    const escaped = existing.title.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        '\\$&'
                    )
                    const changed = linked.content.replace(
                        new RegExp(`\\[\\[${escaped}(?=\\]|\\|)`, 'g'),
                        `[[${title}`
                    )
                    if (changed === linked.content) continue
                    const linkedFile = join(
                        workspace.directory,
                        ...linked.relativePath.split('/')
                    )
                    const updatedLinked = {
                        ...linked,
                        content: changed,
                        links: linksFrom(changed),
                        updated: operationTime,
                    }
                    const linkedHistory = join(
                        workspace.historyDirectory,
                        linked.id
                    )
                    await fileSystem.mkdir(linkedHistory, { recursive: true })
                    await writeAtomically(
                        fileSystem,
                        join(linkedHistory, `${operationTime.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.md`),
                        await fileSystem.readFile(linkedFile, 'utf8')
                    )
                    await writeAtomically(
                        fileSystem,
                        linkedFile,
                        serializeDocument(updatedLinked)
                    )
                }
            }
            await rebuildIndex(input.characterId, input.chatId)
            return prepared.document
        },

        async setDocumentContextMode(input: {
            characterId: string
            chatId: string
            documentId: string
            contextMode: MarkdownWikiContextMode
            expectedContentHash?: string
        }): Promise<MarkdownWikiDocument> {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const document = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === required(
                input.documentId,
                'Document ID'
            ))
            if (!document) {
                throw new Error('Canonical wiki document does not exist')
            }
            if (document.type === 'event' || document.type === 'scene') {
                throw new Error('This document has a fixed context mode')
            }
            if (!['always', 'auto', 'never'].includes(input.contextMode)) {
                throw new Error('Invalid wiki context mode')
            }
            if (input.expectedContentHash
                && document.contentHash !== input.expectedContentHash) {
                throw new Error(
                    'Wiki document changed since the draft was created'
                )
            }
            const file = join(
                workspace.directory,
                ...document.relativePath.split('/')
            )
            const operationTime = now().toISOString()
            const history = join(workspace.historyDirectory, document.id)
            await fileSystem.mkdir(history, { recursive: true })
            await writeAtomically(
                fileSystem,
                join(history, `${operationTime.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.md`),
                await fileSystem.readFile(file, 'utf8')
            )
            const { contentHash: _contentHash, ...stored } = document
            const prepared = prepareDocument({
                ...stored,
                contextMode: input.contextMode,
                updated: operationTime,
            })
            await writeAtomically(fileSystem, file, prepared.contents)
            await rebuildIndex(input.characterId, input.chatId)
            return prepared.document
        },

        async trashDocument(input: {
            characterId: string
            chatId: string
            documentId: string
        }): Promise<{ id: string; trashed: true }> {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const document = (await loadDocuments(input.characterId, input.chatId))
                .find((item) => item.id === required(input.documentId, 'Document ID'))
            if (!document) throw new Error('Canonical wiki document does not exist')
            if (document.type === 'event') {
                throw new Error('Event documents are read-only')
            }
            const file = join(workspace.directory, ...document.relativePath.split('/'))
            const trash = join(workspace.trashDirectory, document.id)
            await fileSystem.mkdir(trash, { recursive: true })
            const stamp = now().toISOString().replace(/[:.]/g, '-')
            await writeAtomically(
                fileSystem,
                join(trash, `${stamp}-${basename(file)}`),
                await fileSystem.readFile(file, 'utf8')
            )
            await fileSystem.rm(file)
            await rebuildIndex(input.characterId, input.chatId)
            return { id: document.id, trashed: true as const }
        },

        async retractEvent(input: {
            characterId: string
            chatId: string
            documentId: string
            expectedContentHash: string
        }): Promise<MarkdownWikiDocument> {
            const workspace = workspaceFor(input.characterId, input.chatId)
            const document = (await loadDocuments(
                input.characterId,
                input.chatId
            )).find((item) => item.id === required(
                input.documentId,
                'Document ID'
            ))
            if (!document || document.type !== 'event') {
                throw new Error('Event document does not exist')
            }
            if (document.status !== 'active') {
                throw new Error('Only an active event can be retracted')
            }
            if (document.contentHash !== required(
                input.expectedContentHash,
                'Content hash'
            )) {
                throw new Error('Wiki event changed since it was opened')
            }
            const file = join(
                workspace.directory,
                ...document.relativePath.split('/')
            )
            const { contentHash: _contentHash, ...stored } = document
            const prepared = prepareDocument({
                ...stored,
                status: 'retracted',
                updated: now().toISOString(),
            })
            await fileSystem.rm(file, { force: true })
            try {
                await rebuildIndex(input.characterId, input.chatId)
            } catch {
                documentCache.delete(workspace.directory)
            }
            return prepared.document
        },

        async retractEventsBySourceMessages(input: {
            characterId: string
            chatId: string
            sourceMessageIds: string[]
        }): Promise<{ retractedIds: string[] }> {
            const sources = new Set(input.sourceMessageIds.map((id) =>
                required(id, 'Source message ID')
            ))
            if (sources.size === 0 || sources.size > 100) {
                throw new Error('Event retraction requires 1-100 source messages')
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const matches = (await loadDocuments(
                input.characterId,
                input.chatId
            )).filter((document) =>
                document.type === 'event'
                && document.status === 'active'
                && document.sourceMessageIds.some((id) => sources.has(id))
            )
            for (const document of matches) {
                await fileSystem.rm(
                    join(
                        workspace.directory,
                        ...document.relativePath.split('/')
                    ),
                    { force: true }
                )
            }
            if (matches.length > 0) {
                await rebuildIndex(input.characterId, input.chatId)
            }
            return { retractedIds: matches.map((document) => document.id) }
        },

        async loadView(
            characterId: string,
            chatId: string
        ): Promise<MarkdownWikiView> {
            const workspace = workspaceFor(characterId, chatId)
            const documents = await refreshDocuments(characterId, chatId)
            const withReviewBases = await Promise.all(documents.map(
                async (document) => {
                    if (document.reviewStatus !== 'unreviewed') return document
                    try {
                        const baseline = await fileSystem.readFile(join(
                            workspace.reviewDirectory,
                            `${stableId([document.id])}.md`
                        ), 'utf8')
                        return {
                            ...document,
                            reviewBaseContent: baseline.length > 0
                                ? parseDocument(
                                    baseline,
                                    document.relativePath
                                ).content
                                : '',
                        }
                    }
                    catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                            return document
                        }
                        throw error
                    }
                }
            ))
            return {
                mode: 'markdown' as const,
                wikiPath: workspaceFor(characterId, chatId).directory,
                documents: withReviewBases,
                health: computeHealth(documents),
            }
        },

        async replaceAllText(input: {
            characterId: string
            chatId: string
            find: string
            replacement: string
        }): Promise<{ matches: number; documents: number }> {
            if (typeof input.find !== 'string'
                || input.find.length === 0
                || input.find.length > 256) {
                throw new Error('Find text must contain 1-256 characters')
            }
            const find = input.find
            if (typeof input.replacement !== 'string'
                || input.replacement.length > 256) {
                throw new Error('Replacement text is too long')
            }
            if (find === input.replacement) {
                return { matches: 0, documents: 0 }
            }
            const workspace = workspaceFor(input.characterId, input.chatId)
            const documents = await loadDocuments(
                input.characterId,
                input.chatId
            )
            const operationTime = now().toISOString()
            const staged = documents.flatMap((document) => {
                const contentMatches = document.content.split(find).length - 1
                if (contentMatches === 0) return []
                const { contentHash: _contentHash, ...stored } = document
                const content = stored.content.replaceAll(
                    find,
                    input.replacement
                )
                const prepared = prepareDocument({
                    ...stored,
                    title: stored.title.replaceAll(find, input.replacement),
                    content,
                    links: linksFrom(content),
                    updated: operationTime,
                })
                return [{
                    document,
                    matches: contentMatches,
                    file: join(
                        workspace.directory,
                        ...document.relativePath.split('/')
                    ),
                    prepared,
                }]
            })
            if (staged.length === 0) {
                return { matches: 0, documents: 0 }
            }
            const originals = await Promise.all(staged.map(async (item) => ({
                ...item,
                contents: await fileSystem.readFile(item.file, 'utf8'),
            })))
            const written: typeof originals = []
            try {
                for (const item of originals) {
                    await writeAtomically(
                        fileSystem,
                        item.file,
                        item.prepared.contents
                    )
                    written.push(item)
                }
            }
            catch (error) {
                await Promise.allSettled(written.map((item) =>
                    writeAtomically(fileSystem, item.file, item.contents)
                ))
                await refreshDocuments(input.characterId, input.chatId)
                throw error
            }
            await rebuildIndex(input.characterId, input.chatId)
            return {
                matches: staged.reduce(
                    (total, item) => total + item.matches,
                    0
                ),
                documents: staged.length,
            }
        },

        async inquire(input: {
            characterId: string
            chatId: string
            currentInput: string
            tokenBudget?: {
                target: number
                maximum: number
            }
        }) {
            return inquireMarkdownDocuments({
                documents: await loadDocuments(
                    input.characterId,
                    input.chatId
                ),
                currentInput: input.currentInput,
                ...(input.tokenBudget
                    ? { tokenBudget: input.tokenBudget }
                    : {}),
            })
        },
    }
}
