import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createMarkdownNarrativeWiki } from './risubard-markdown-wiki'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import {
    completeMemoryWorkspaceFork,
    forkMemoryWorkspace,
} from './risubard-memory-fork'

const temporaryDirectories: string[] = []

async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-fork-'))
    temporaryDirectories.push(root)
    return root
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
    ))
})

describe('memory workspace fork', () => {
    test('copies the complete workspace and keeps source and destination independent', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'source')
        const destination = resolveMemoryWorkspace(root, 'character', 'copy')
        await fs.mkdir(join(source.directory, 'wiki', '.risubard-history'), {
            recursive: true,
        })
        await fs.writeFile(source.stateFile, 'source-state')
        await fs.writeFile(source.eventsFile, 'source-events')
        await fs.writeFile(join(source.directory, 'wiki', 'current-scene.md'), 'scene')
        await fs.writeFile(join(
            source.directory, 'wiki', '.risubard-history', 'audit.md'
        ), 'audit')

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        })).resolves.toMatchObject({
            mode: 'copy', sourceExists: true, forkToken: expect.any(String),
        })

        await expect(fs.readFile(destination.stateFile, 'utf8'))
            .resolves.toBe('source-state')
        await expect(fs.readFile(join(
            destination.directory, 'wiki', '.risubard-history', 'audit.md'
        ), 'utf8')).resolves.toBe('audit')
        await fs.writeFile(destination.stateFile, 'copy-state')
        await expect(fs.readFile(source.stateFile, 'utf8'))
            .resolves.toBe('source-state')
    })

    test('copies a workspace into a different character namespace', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'source-character', 'source')
        const destination = resolveMemoryWorkspace(root, 'clone-character', 'copy')
        await fs.mkdir(source.directory, { recursive: true })
        await fs.writeFile(source.stateFile, 'source-state')

        await forkMemoryWorkspace({
            userDataDirectory: root,
            characterId: 'source-character',
            destinationCharacterId: 'clone-character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        })

        await expect(fs.readFile(destination.stateFile, 'utf8'))
            .resolves.toBe('source-state')
    })

    test('finalizes or discards only with the matching fork token', async () => {
        const root = await createRoot()
        const finalized = await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'missing', destinationChatId: 'finalized',
            mode: 'copy',
        })
        await expect(completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'finalized', forkToken: finalized.forkToken,
            action: 'finalize',
        })).resolves.toEqual({ action: 'finalize', completed: true })
        await expect(completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'finalized', forkToken: finalized.forkToken,
            action: 'discard',
        })).rejects.toThrow(/token|marker/i)
        await expect(fs.stat(resolveMemoryWorkspace(
            root, 'character', 'finalized'
        ).directory)).resolves.toMatchObject({})

        const discarded = await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'missing', destinationChatId: 'discarded',
            mode: 'copy',
        })
        await expect(completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'discarded', forkToken: 'wrong-token',
            action: 'discard',
        })).rejects.toThrow(/token/i)
        await completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'discarded', forkToken: discarded.forkToken,
            action: 'discard',
        })
        await expect(fs.stat(resolveMemoryWorkspace(
            root, 'character', 'discarded'
        ).directory)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    test('creates an empty independent destination when the source is absent', async () => {
        const root = await createRoot()
        const destination = resolveMemoryWorkspace(
            root, 'character', 'empty-copy'
        )

        const receipt = await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'missing', destinationChatId: 'empty-copy',
            mode: 'copy',
        })
        expect(receipt).toMatchObject({ sourceExists: false })
        await completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'empty-copy', forkToken: receipt.forkToken,
            action: 'finalize',
        })
        await expect(fs.stat(destination.directory)).resolves.toMatchObject({})
        await expect(fs.readdir(destination.directory)).resolves.toEqual([])
    })

    test('rejects source equals destination and an existing destination', async () => {
        const root = await createRoot()
        const destination = resolveMemoryWorkspace(root, 'character', 'copy')
        await fs.mkdir(destination.directory, { recursive: true })

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'same', destinationChatId: 'same', mode: 'copy',
        })).rejects.toThrow('must differ')
        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        })).rejects.toThrow('already exists')
    })

    test('allows only one concurrent fork to claim a destination', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'source')
        await fs.mkdir(source.directory, { recursive: true })
        await fs.writeFile(source.stateFile, 'source-state')
        const input = {
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'copy',
            mode: 'copy' as const,
        }

        const results = await Promise.allSettled([
            forkMemoryWorkspace(input),
            forkMemoryWorkspace(input),
        ])

        expect(results.filter((result) => result.status === 'fulfilled'))
            .toHaveLength(1)
        expect(results.filter((result) => result.status === 'rejected'))
            .toHaveLength(1)
        await expect(fs.readFile(resolveMemoryWorkspace(
            root, 'character', 'copy'
        ).stateFile, 'utf8')).resolves.toBe('source-state')
    })

    test('cleans staging and leaves source and destination safe on copy failure', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'source')
        const destination = resolveMemoryWorkspace(root, 'character', 'copy')
        await fs.mkdir(source.directory, { recursive: true })
        await fs.writeFile(source.stateFile, 'source-state')

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        }, {
            fileSystem: {
                ...fs,
                copyFile: async () => {
                    throw new Error('simulated copy failure')
                },
            },
        })).rejects.toThrow('simulated copy failure')

        await expect(fs.readFile(source.stateFile, 'utf8'))
            .resolves.toBe('source-state')
        await expect(fs.stat(destination.directory)).rejects.toMatchObject({
            code: 'ENOENT',
        })
        const siblings = await fs.readdir(dirname(destination.directory))
        expect(siblings.some((name) => name.includes('.fork-'))).toBe(false)
    })

    test('branches from the first future receipt without leaking later scene or events', async () => {
        const root = await createRoot()
        const wiki = createMarkdownNarrativeWiki(root)
        const scene = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'source', type: 'scene',
            title: '현재 장면', markdown: '# 현재 장면\n\n과거 장면.',
        })
        const pastSnapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['user-1', 'assistant-1'],
        })
        const pastScene = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'source', documentId: scene.id,
            type: 'scene', title: scene.title,
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 현재 장면\n\n확정된 과거 장면.',
            expectedContentHash: scene.contentHash,
        })
        const pastEvent = await wiki.saveConfirmedTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 과거 사건\n\n문이 열렸다.',
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: pastSnapshot.snapshotId,
            sourceMessageIds: ['user-1', 'assistant-1'],
            eventId: pastEvent.id,
            changes: [{
                documentId: pastScene.id, type: pastScene.type,
                title: pastScene.title, relativePath: pastScene.relativePath,
                afterHash: pastScene.contentHash,
            }], warnings: [],
        })

        const futureSnapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['user-2', 'assistant-2'],
        })
        const futureScene = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'source',
            documentId: pastScene.id, type: 'scene', title: pastScene.title,
            sourceMessageIds: ['user-2', 'assistant-2'],
            markdown: '# 현재 장면\n\n미래의 성 안뜰.',
            expectedContentHash: pastScene.contentHash,
        })
        const futureEvent = await wiki.saveConfirmedTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['user-2', 'assistant-2'],
            markdown: '# 미래 사건\n\n왕이 도착했다.',
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: futureSnapshot.snapshotId,
            sourceMessageIds: ['user-2', 'assistant-2'],
            eventId: futureEvent.id,
            changes: [{
                documentId: futureScene.id, type: futureScene.type,
                title: futureScene.title,
                relativePath: futureScene.relativePath,
                afterHash: futureScene.contentHash,
            }], warnings: [],
        })

        await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['user-1', 'assistant-1'],
            messageIds: [
                'user-1', 'assistant-1', 'user-2', 'assistant-2',
            ],
        })

        const branch = await wiki.loadView('character', 'branch')
        expect(branch.documents.find((item) => item.type === 'scene')?.content)
            .toContain('확정된 과거 장면')
        expect(branch.documents.some((item) => item.id === pastEvent.id)).toBe(true)
        expect(branch.documents.some((item) => item.id === futureEvent.id)).toBe(false)
        expect(JSON.stringify(branch.documents)).not.toContain('미래의 성 안뜰')
        const branchWorkspace = resolveMemoryWorkspace(
            root, 'character', 'branch'
        )
        const snapshots = await fs.readdir(join(
            branchWorkspace.directory, 'wiki', '.risubard-snapshots'
        ))
        expect(snapshots).toEqual([pastSnapshot.snapshotId])
    })

    test('treats an undone future turn as an audit cutoff', async () => {
        const root = await createRoot()
        const wiki = createMarkdownNarrativeWiki(root)
        const page = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'source', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n과거 상태.',
        })
        const snapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-future'],
        })
        const future = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'source', documentId: page.id,
            type: 'character', title: page.title,
            sourceMessageIds: ['assistant-future'],
            markdown: '# 라비안\n\n미래 상태.',
            expectedContentHash: page.contentHash,
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: snapshot.snapshotId,
            sourceMessageIds: ['assistant-future'],
            changes: [{
                documentId: future.id, type: future.type,
                title: future.title, relativePath: future.relativePath,
                afterHash: future.contentHash,
            }], warnings: [],
        })
        await wiki.undoTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: snapshot.snapshotId,
        })
        const sourceWorkspace = resolveMemoryWorkspace(
            root, 'character', 'source'
        )
        const history = join(
            sourceWorkspace.directory,
            'wiki',
            '.risubard-history',
            'future-audit.md'
        )
        await fs.mkdir(dirname(history), { recursive: true })
        await fs.writeFile(history, '미래 감사 정보')

        const receipt = await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: [],
            messageIds: ['assistant-future'],
        })

        expect(receipt.warnings).not.toEqual([])
        const branchWorkspace = resolveMemoryWorkspace(
            root, 'character', 'branch'
        )
        await expect(fs.stat(join(
            branchWorkspace.directory,
            'wiki',
            '.risubard-history'
        ))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(JSON.stringify((await wiki.loadView(
            'character', 'branch'
        )).documents)).not.toContain('미래 상태')
    })

    test('rejects a manual edit mixed with a future automatic change', async () => {
        const root = await createRoot()
        const wiki = createMarkdownNarrativeWiki(root)
        const page = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'source', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n과거 상태.',
        })
        const snapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-future'],
        })
        const future = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'source', documentId: page.id,
            type: 'character', title: page.title,
            sourceMessageIds: ['assistant-future'],
            markdown: '# 라비안\n\n미래 자동 상태.',
            expectedContentHash: page.contentHash,
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: snapshot.snapshotId,
            sourceMessageIds: ['assistant-future'],
            changes: [{
                documentId: future.id, type: future.type,
                title: future.title, relativePath: future.relativePath,
                afterHash: future.contentHash,
            }], warnings: [],
        })
        await wiki.saveManualDocument({
            characterId: 'character', chatId: 'source', documentId: future.id,
            type: 'character', title: future.title,
            markdown: '# 라비안\n\n미래 상태를 바탕으로 한 수동 교정.',
        })

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: [],
            messageIds: ['assistant-future'],
        })).rejects.toThrow(/manual.*future|수동.*미래|conflict/i)
        await expect(fs.stat(resolveMemoryWorkspace(
            root, 'character', 'branch'
        ).directory)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    test('orders future snapshots by chat messages instead of mutable timestamps', async () => {
        const root = await createRoot()
        let clock = '2026-08-13T00:00:00.000Z'
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => new Date(clock),
        })
        const scene = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'source', type: 'scene',
            title: '현재 장면', markdown: '# 현재 장면\n\n과거.',
        })
        const first = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-2'],
        })
        const firstScene = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'source', documentId: scene.id,
            type: 'scene', title: scene.title,
            sourceMessageIds: ['assistant-2'],
            markdown: '# 현재 장면\n\n첫 미래.',
            expectedContentHash: scene.contentHash,
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: first.snapshotId,
            sourceMessageIds: ['assistant-2'], changes: [{
                documentId: firstScene.id, type: firstScene.type,
                title: firstScene.title, relativePath: firstScene.relativePath,
                afterHash: firstScene.contentHash,
            }], warnings: [],
        })
        clock = '2026-08-12T00:00:00.000Z'
        const second = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-3'],
        })
        const secondScene = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'source',
            documentId: firstScene.id, type: 'scene', title: firstScene.title,
            sourceMessageIds: ['assistant-3'],
            markdown: '# 현재 장면\n\n둘째 미래.',
            expectedContentHash: firstScene.contentHash,
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: second.snapshotId,
            sourceMessageIds: ['assistant-3'], changes: [{
                documentId: secondScene.id, type: secondScene.type,
                title: secondScene.title, relativePath: secondScene.relativePath,
                afterHash: secondScene.contentHash,
            }], warnings: [],
        })

        await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['assistant-1'],
            messageIds: ['assistant-1', 'assistant-2', 'assistant-3'],
        })

        expect((await wiki.loadView('character', 'branch')).documents
            .find((document) => document.type === 'scene')?.content)
            .toContain('과거')
    })

    test('rejects mismatched snapshot and receipt sources', async () => {
        const root = await createRoot()
        const wiki = createMarkdownNarrativeWiki(root)
        const snapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-2'],
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: snapshot.snapshotId,
            sourceMessageIds: ['assistant-2'], changes: [], warnings: [],
        })
        const workspace = resolveMemoryWorkspace(root, 'character', 'source')
        const manifestFile = join(
            workspace.directory, 'wiki', '.risubard-snapshots',
            snapshot.snapshotId, 'manifest.json'
        )
        const manifest = JSON.parse(await fs.readFile(manifestFile, 'utf8'))
        manifest.receipt.sourceMessageIds = ['assistant-3']
        await fs.writeFile(manifestFile, JSON.stringify(manifest))

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['assistant-1'],
            messageIds: ['assistant-1', 'assistant-2', 'assistant-3'],
        })).rejects.toThrow(/snapshot.*receipt.*source|source.*mismatch/i)
    })

    test('preserves an unrelated manual rename without duplicating its document ID', async () => {
        const root = await createRoot()
        const wiki = createMarkdownNarrativeWiki(root)
        const page = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'source', type: 'character',
            title: '이전 이름', markdown: '# 이전 이름\n\n과거 기록.',
        })
        const scene = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'source', type: 'scene',
            title: '현재 장면', markdown: '# 현재 장면\n\n과거.',
        })
        const snapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-2'],
        })
        const futureScene = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'source', documentId: scene.id,
            type: 'scene', title: scene.title,
            sourceMessageIds: ['assistant-2'],
            markdown: '# 현재 장면\n\n미래.',
            expectedContentHash: scene.contentHash,
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: snapshot.snapshotId,
            sourceMessageIds: ['assistant-2'], changes: [{
                documentId: futureScene.id, type: futureScene.type,
                title: futureScene.title,
                relativePath: futureScene.relativePath,
                afterHash: futureScene.contentHash,
            }], warnings: [],
        })
        await wiki.saveManualDocument({
            characterId: 'character', chatId: 'source', documentId: page.id,
            type: 'character', title: '최신 이름',
            markdown: '# 최신 이름\n\n사용자 교정.',
        })

        await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['assistant-1'],
            messageIds: ['assistant-1', 'assistant-2'],
        })

        const matches = (await wiki.loadView('character', 'branch')).documents
            .filter((document) => document.id === page.id)
        expect(matches).toHaveLength(1)
        expect(matches[0].title).toBe('최신 이름')
    })

    test('rejects unassignable review state instead of silently deleting it', async () => {
        const root = await createRoot()
        const wiki = createMarkdownNarrativeWiki(root)
        const snapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'source',
            sourceMessageIds: ['assistant-2'],
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'source',
            snapshotId: snapshot.snapshotId,
            sourceMessageIds: ['assistant-2'], changes: [], warnings: [],
        })
        const workspace = resolveMemoryWorkspace(root, 'character', 'source')
        const review = join(workspace.directory, 'wiki', '.risubard-review')
        await fs.mkdir(review, { recursive: true })
        await fs.writeFile(join(review, 'unassignable.md'), 'review baseline')

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['assistant-1'],
            messageIds: ['assistant-1', 'assistant-2'],
        })).rejects.toThrow(/review.*conflict|conflict.*review/i)
    })
})
