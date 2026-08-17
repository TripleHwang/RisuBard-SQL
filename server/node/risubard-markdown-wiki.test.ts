import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
    createMarkdownNarrativeWiki,
    resolveMarkdownWikiWorkspace,
} from './risubard-markdown-wiki'

const temporaryDirectories: string[] = []

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
    ))
})

describe('Markdown narrative wiki', () => {
    test('replaces literal text in canonical and event documents without history', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => new Date('2026-08-16T01:02:03.000Z'),
        })
        const character = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '길버드', markdown: '# 길버드\n\n길버드는 기사다.',
        })
        const event = await wiki.saveConfirmedTurn({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '길버드가 성문을 열었다.',
        })

        await expect(wiki.replaceAllText({
            characterId: 'character', chatId: 'chat',
            find: '길버드', replacement: '길버트',
        })).resolves.toEqual({ matches: 4, documents: 2 })

        const view = await wiki.loadView('character', 'chat')
        expect(view.documents.find((item) => item.id === character.id))
            .toMatchObject({ title: '길버트' })
        expect(view.documents.find((item) => item.id === event.id)?.content)
            .toContain('길버트가 성문을 열었다.')
        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')
        await expect(fs.access(join(
            workspace.historyDirectory, character.id
        ))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(fs.access(join(
            workspace.historyDirectory, event.id
        ))).rejects.toMatchObject({ code: 'ENOENT' })
    })

    test('reuses parsed Markdown between inquiries and refreshes after writes', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        let readCount = 0
        const countingFileSystem = {
            ...fs,
            readFile: async (...args: unknown[]) => {
                readCount += 1
                return (fs.readFile as unknown as (
                    ...values: unknown[]
                ) => Promise<unknown>)(...args)
            },
        } as unknown as NonNullable<
            Parameters<typeof createMarkdownNarrativeWiki>[1]
        >['fileSystem']
        const wiki = createMarkdownNarrativeWiki(root, {
            fileSystem: countingFileSystem,
        })
        await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n기사다.',
        })
        const afterFirstWrite = readCount

        await wiki.inquire({
            characterId: 'character', chatId: 'chat',
            currentInput: '라비안은 누구지?',
        })
        await wiki.inquire({
            characterId: 'character', chatId: 'chat',
            currentInput: '라비안의 상태는?',
        })
        expect(readCount).toBe(afterFirstWrite)

        await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'item',
            title: '은빛 창', markdown: '# 은빛 창\n\n라비안의 무기다.',
        })
        const afterSecondWrite = readCount
        const inquiry = await wiki.inquire({
            characterId: 'character', chatId: 'chat',
            currentInput: '은빛 창은 무엇이지?',
        })

        expect(readCount).toBe(afterSecondWrite)
        expect(inquiry.sources.some((source) =>
            source.id.includes('wiki:items/'))).toBe(true)
    })

    test('creates an AI-free canonical page with program-owned metadata', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => new Date('2026-08-08T06:07:08.000Z'),
        })

        const created = await wiki.saveManualDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'faction',
            title: '은촛대 수도회',
            markdown: '# 은촛대 수도회\n\n사용자가 직접 기록했다.',
        })

        expect(created).toEqual(expect.objectContaining({
            type: 'faction',
            title: '은촛대 수도회',
            sourceMessageIds: [],
            created: '2026-08-08T06:07:08.000Z',
            updated: '2026-08-08T06:07:08.000Z',
            authoring: 'manual',
            relativePath: expect.stringMatching(/^factions\//),
        }))
        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')
        const contents = await fs.readFile(
            join(workspace.directory, ...created.relativePath.split('/')),
            'utf8'
        )
        expect(contents).toContain(`id: ${JSON.stringify(created.id)}`)
        expect(contents).toContain('type: faction')
        expect(contents).toContain('authoring: manual')
        expect(contents).toContain('created: "2026-08-08T06:07:08.000Z"')
    })

    test('adds visible wikilinks for exact known titles on automatic writes', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '길버드', markdown: '# 길버드\n\n고아원장이다.',
        })

        const created = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '리즐렛', sourceMessageIds: ['turn-1'],
            markdown: [
                '# 리즐렛',
                '',
                '## 대인 관계',
                '',
                '- **길버드**: 자신을 거두어 준 신부이자 고아원장이다.',
            ].join('\n'),
        })

        expect(created.content).toContain('## 관련 문서')
        expect(created.content).toContain('- [[길버드]]')
        expect(created.links).toContain('길버드')
    })

    test('resolves only an existing document ID to its absolute wiki file', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const created = await wiki.saveManualDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'character',
            title: '라비안',
            markdown: '# 라비안\n\n기사.',
        })
        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')

        await expect(wiki.resolveDocumentFile({
            characterId: 'character',
            chatId: 'chat',
            documentId: created.id,
        })).resolves.toBe(join(
            workspace.directory,
            ...created.relativePath.split('/')
        ))
        await expect(wiki.resolveDocumentFile({
            characterId: 'character',
            chatId: 'chat',
            documentId: '../escape',
        })).rejects.toThrow('Wiki document does not exist')
    })

    test('snapshots canonical pages before applying a confirmed turn', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => new Date('2026-08-09T01:02:03.000Z'),
        })
        const page = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n이전 상태.',
        })
        await wiki.saveConfirmedTurn({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['assistant-old'],
            markdown: '# 이전 사건\n\n과거 사건.',
        })

        const receipt = await wiki.snapshotBeforeTurn({
            characterId: 'character',
            chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
        })

        expect(receipt).toMatchObject({ canonicalCount: 1 })
        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')
        const snapshot = join(workspace.snapshotsDirectory, receipt.snapshotId)
        await expect(fs.readFile(
            join(snapshot, ...page.relativePath.split('/')),
            'utf8'
        )).resolves.toContain('이전 상태')
        await expect(fs.readFile(join(snapshot, 'manifest.json'), 'utf8'))
            .resolves.toContain('event.')

        await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', documentId: page.id,
            type: 'character', title: '라비안',
            markdown: '# 라비안\n\n갱신된 상태.',
        })
        await wiki.snapshotBeforeTurn({
            characterId: 'character',
            chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
        })
        await expect(fs.readFile(
            join(snapshot, ...page.relativePath.split('/')),
            'utf8'
        )).resolves.toContain('이전 상태')
    })

    test('records a turn receipt and safely undoes one page or the whole turn', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const original = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'location',
            title: '케사리아 외곽 폐촌',
            markdown: '# 케사리아 외곽 폐촌\n\n이전 상태.',
        })
        const snapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
        })
        const event = await wiki.saveConfirmedTurn({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 폐촌 도착\n\n도착했다.',
        })
        const updated = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat',
            documentId: original.id, type: 'location',
            title: original.title,
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 케사리아 외곽 폐촌\n\n새 상태.',
            expectedContentHash: original.contentHash,
        })
        const created = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', type: 'item',
            title: '은빛 열쇠', sourceMessageIds: ['assistant-1'],
            markdown: '# 은빛 열쇠\n\n새로 생겼다.',
        })
        const receipt = await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'chat',
            snapshotId: snapshot.snapshotId,
            sourceMessageIds: ['user-1', 'assistant-1'],
            eventId: event.id,
            changes: [updated, created].map((document) => ({
                documentId: document.id,
                type: document.type,
                title: document.title,
                relativePath: document.relativePath,
                afterHash: document.contentHash,
            })),
            warnings: ['낮은 확신: 은빛 열쇠'],
        })
        expect(receipt.changes).toEqual(expect.arrayContaining([
            expect.objectContaining({
                documentId: original.id, action: 'update',
                beforeHash: original.contentHash,
            }),
            expect.objectContaining({
                documentId: created.id, action: 'create', beforeHash: null,
            }),
        ]))

        const partial = await wiki.undoTurnReceipt({
            characterId: 'character', chatId: 'chat',
            snapshotId: snapshot.snapshotId, documentId: created.id,
        })
        expect(partial.changes.find((change) =>
            change.documentId === created.id
        )?.undoneAt).toBeTruthy()
        expect((await wiki.loadView('character', 'chat')).documents
            .some((document) => document.id === created.id)).toBe(false)

        const undone = await wiki.undoTurnReceipt({
            characterId: 'character', chatId: 'chat',
            snapshotId: snapshot.snapshotId,
        })
        const view = await wiki.loadView('character', 'chat')
        expect(view.documents.find((document) => document.id === original.id)
            ?.content).toContain('이전 상태')
        expect(view.documents.some((document) => document.id === event.id))
            .toBe(false)
        expect(undone.undoneAt).toBeTruthy()
    })

    test('preserves conflicts while undoing the safe remainder of a turn', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const original = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n이전 상태.',
        })
        const snapshot = await wiki.snapshotBeforeTurn({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['assistant-1'],
        })
        const updated = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            type: 'character', title: '라비안',
            sourceMessageIds: ['assistant-1'], markdown: '# 라비안\n\n자동 상태.',
            expectedContentHash: original.contentHash,
        })
        const created = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', type: 'item',
            title: '은빛 열쇠', sourceMessageIds: ['assistant-1'],
            markdown: '# 은빛 열쇠\n\n새로 생겼다.',
        })
        await wiki.recordTurnReceipt({
            characterId: 'character', chatId: 'chat',
            snapshotId: snapshot.snapshotId, sourceMessageIds: ['assistant-1'],
            changes: [updated, created].map((document) => ({
                documentId: document.id, type: document.type,
                title: document.title, relativePath: document.relativePath,
                afterHash: document.contentHash,
            })), warnings: [],
        })
        await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', documentId: updated.id,
            type: 'character', title: '라비안',
            markdown: '# 라비안\n\n사용자의 후속 편집.',
        })
        await expect(wiki.undoTurnReceipt({
            characterId: 'character', chatId: 'chat',
            snapshotId: snapshot.snapshotId, documentId: updated.id,
        })).rejects.toThrow(/changed after|후속|conflict/i)

        const receipt = await wiki.undoTurnReceipt({
            characterId: 'character', chatId: 'chat',
            snapshotId: snapshot.snapshotId,
        })
        const view = await wiki.loadView('character', 'chat')
        expect(view.documents.find((document) => document.id === updated.id)
            ?.content).toContain('사용자의 후속 편집')
        expect(view.documents.some((document) =>
            document.id === created.id
        )).toBe(false)
        expect(receipt.changes.find((change) =>
            change.documentId === updated.id
        )?.undoConflict).toBe('changed-after-turn')
        expect(receipt.changes.find((change) =>
            change.documentId === created.id
        )?.undoneAt).toBeTruthy()
        expect(receipt.undoneAt).toBeTruthy()
    })

    test('renames and moves a manual page while preserving its ID and backlinks', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const times = [
            new Date('2026-08-08T06:00:00.000Z'),
            new Date('2026-08-08T07:00:00.000Z'),
        ]
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => times.shift() ?? new Date('2026-08-08T08:00:00.000Z'),
        })
        const created = await wiki.saveManualDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'character',
            title: '라비안',
            markdown: '# 라비안\n\n기사.',
        })
        const linked = await wiki.saveManualDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'location',
            title: '소성당',
            markdown: '# 소성당\n\n[[라비안]]이 머문다.',
        })

        const renamed = await wiki.saveManualDocument({
            characterId: 'character',
            chatId: 'chat',
            documentId: created.id,
            type: 'location',
            title: '라비안의 은신처',
            markdown: '# 라비안의 은신처\n\n현재는 장소로 관리한다.',
        })

        expect(renamed.id).toBe(created.id)
        expect(renamed.relativePath).toMatch(/^locations\//)
        expect(renamed.relativePath).not.toBe(created.relativePath)
        const view = await wiki.loadView('character', 'chat')
        expect(view.documents.find((item) => item.id === linked.id)?.content)
            .toContain('[[라비안의 은신처]]')
        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')
        await expect(fs.readFile(
            join(workspace.directory, ...created.relativePath.split('/')),
            'utf8'
        )).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await fs.readdir(join(workspace.historyDirectory, created.id)))
            .toHaveLength(1)
    })

    test('moves canonical pages to recoverable trash and rejects event deletion', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => new Date('2026-08-08T09:00:00.000Z'),
        })
        const page = await wiki.saveManualDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'item',
            title: '은 열쇠',
            markdown: '# 은 열쇠\n\n낡은 열쇠.',
        })
        const event = await wiki.saveConfirmedTurn({
            characterId: 'character',
            chatId: 'chat',
            sourceMessageIds: ['assistant-1'],
            markdown: '# 발견\n\n열쇠를 발견했다.',
        })

        await wiki.trashDocument({
            characterId: 'character',
            chatId: 'chat',
            documentId: page.id,
        })

        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')
        expect(await fs.readdir(join(workspace.trashDirectory, page.id)))
            .toHaveLength(1)
        expect((await wiki.loadView('character', 'chat')).documents
            .some((item) => item.id === page.id)).toBe(false)
        await expect(wiki.trashDocument({
            characterId: 'character',
            chatId: 'chat',
            documentId: event.id,
        })).rejects.toThrow('Event documents are read-only')
    })

    test('permanently deletes a retracted event from the view and filesystem', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const times = [
            new Date('2026-08-12T01:00:00.000Z'),
            new Date('2026-08-12T02:00:00.000Z'),
        ]
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => times.shift() ?? new Date('2026-08-12T03:00:00.000Z'),
        })
        const event = await wiki.saveConfirmedTurn({
            characterId: 'character',
            chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 잘못된 첫 만남\n\n히사시가 등장했다.',
        })

        const retracted = await wiki.retractEvent({
            characterId: 'character',
            chatId: 'chat',
            documentId: event.id,
            expectedContentHash: event.contentHash,
        })

        expect(retracted).toMatchObject({
            id: event.id,
            type: 'event',
            status: 'retracted',
            content: event.content,
            updated: '2026-08-12T02:00:00.000Z',
        })
        expect((await wiki.loadView('character', 'chat')).documents
            .some((document) => document.id === event.id)).toBe(false)
        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')
        await expect(fs.access(join(
            workspace.directory, ...event.relativePath.split('/')
        ))).rejects.toMatchObject({ code: 'ENOENT' })
        const inquiry = await wiki.inquire({
            characterId: 'character',
            chatId: 'chat',
            currentInput: '히사시 첫 만남',
        })
        expect(inquiry.sources.some((source) =>
            source.content.includes('히사시')
        )).toBe(false)
    })

    test('purges legacy retracted event files when loading the wiki', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const event = await wiki.saveConfirmedTurn({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['user-legacy', 'assistant-legacy'],
            markdown: '# 오래된 철회 사건\n\n더는 필요하지 않다.',
        })
        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')
        const eventFile = join(
            workspace.directory, ...event.relativePath.split('/')
        )
        const stored = await fs.readFile(eventFile, 'utf8')
        await fs.writeFile(eventFile, stored.replace(
            'status: active', 'status: retracted'
        ))

        expect((await wiki.loadView('character', 'chat')).documents
            .some((document) => document.id === event.id)).toBe(false)
        await expect(fs.access(eventFile)).rejects.toMatchObject({ code: 'ENOENT' })
    })

    test('retracts active events linked to confirmed messages being deleted', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const removed = await wiki.saveConfirmedTurn({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 잘못된 사건\n\n히사시가 등장했다.',
        })
        const kept = await wiki.saveConfirmedTurn({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['user-2', 'assistant-2'],
            markdown: '# 유지할 사건\n\n라비안이 출발했다.',
        })

        await expect(wiki.retractEventsBySourceMessages({
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['assistant-1'],
        })).resolves.toEqual({ retractedIds: [removed.id] })
        const view = await wiki.loadView('character', 'chat')
        expect(view.documents.some((item) => item.id === removed.id)).toBe(false)
        expect(view.documents.find((item) => item.id === kept.id)?.status)
            .toBe('active')
    })

    test('keeps a stable canonical page and archives its previous revision', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const times = [
            new Date('2026-08-08T01:00:00.000Z'),
            new Date('2026-08-08T02:00:00.000Z'),
        ]
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => times.shift() ?? new Date('2026-08-08T03:00:00.000Z'),
        })

        const created = await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'character',
            title: '라비안',
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 라비안\n\n## 현재 상태\n\n건강하다.',
        })
        const updated = await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: 'chat',
            documentId: created.id,
            type: 'character',
            title: '라비안',
            sourceMessageIds: ['user-2', 'assistant-2'],
            markdown: '# 라비안\n\n## 현재 상태\n\n오른팔에 화상을 입었다.',
        })

        expect(updated.id).toBe(created.id)
        expect(updated.relativePath).toBe(created.relativePath)
        expect(updated.relativePath).toMatch(
            /^characters\/라비안-[a-zA-Z0-9_-]+\.md$/
        )
        const workspace = resolveMarkdownWikiWorkspace(root, 'character', 'chat')
        const revisions = await fs.readdir(
            join(workspace.historyDirectory, created.id)
        )
        expect(revisions).toHaveLength(1)
        expect(await fs.readFile(
            join(workspace.historyDirectory, created.id, revisions[0]),
            'utf8'
        )).toContain('건강하다')
        expect((await wiki.loadView('character', 'chat')).documents)
            .toEqual([expect.objectContaining({
                type: 'character',
                content: expect.stringContaining('화상을 입었다'),
            })])
    })

    test('stores a confirmed turn as an Obsidian-readable Markdown document', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root, {
            now: () => new Date('2026-08-08T00:00:00.000Z'),
        })

        await wiki.saveConfirmedTurn({
            characterId: 'character',
            chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 다리의 붕괴\n\n다리가 무너졌고 [[리나]]가 다쳤다.',
        })

        const workspace = resolveMarkdownWikiWorkspace(
            root,
            'character',
            'chat'
        )
        const files = await fs.readdir(workspace.eventsDirectory)
        expect(files).toHaveLength(1)
        const contents = await fs.readFile(
            join(workspace.eventsDirectory, files[0]),
            'utf8'
        )
        expect(contents).toContain('type: event')
        expect(contents).toContain('status: active')
        expect(contents).toContain('  - "user-1"')
        expect(contents).toContain('  - "assistant-1"')
        expect(contents).toContain('updated: "2026-08-08T00:00:00.000Z"')
        expect(contents).toContain('[[리나]]')
        expect(contents).not.toContain('operations:')

        const view = await wiki.loadView('character', 'chat')
        expect(view.wikiPath).toBe(workspace.directory)
        expect(view.documents).toEqual([
            expect.objectContaining({
                title: '다리의 붕괴',
                relativePath: `events/${files[0]}`,
                sourceMessageIds: ['user-1', 'assistant-1'],
            }),
        ])
        expect(await fs.readFile(workspace.indexFile, 'utf8')).toContain(
            `[[events/${files[0].replace(/\.md$/, '')}|다리의 붕괴]]`
        )
    })

    test('uses the Markdown documents directly as bounded inquiry sources', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        await wiki.saveConfirmedTurn({
            characterId: 'character',
            chatId: 'chat',
            sourceMessageIds: ['assistant-1'],
            markdown: '# 약속\n\n리나는 카인에게 돌아오겠다고 약속했다.',
        })

        const inquiry = await wiki.inquire({
            characterId: 'character',
            chatId: 'chat',
            currentInput: '리나의 약속',
        })

        expect(inquiry.sources).toEqual([
            expect.objectContaining({
                id: expect.stringMatching(/^narrative-memory:wiki:/),
                content: expect.stringContaining('돌아오겠다고 약속했다'),
            }),
        ])
        expect(inquiry.entityCandidates).toEqual([])
    })

    test('retrieves linked provenance two hops away without scanning chat history', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        await wiki.saveManualDocument({
            characterId: 'project', chatId: 'chat', type: 'character',
            title: '프로도',
            markdown: '# 프로도\n\n## 현재 소지품\n\n- [[에아렌딜의 유리병]]',
        })
        await wiki.saveManualDocument({
            characterId: 'project', chatId: 'chat', type: 'item',
            title: '에아렌딜의 유리병',
            markdown: '# 에아렌딜의 유리병\n\n## 효능\n\n어둠 속에서 빛을 낸다.\n\n## 유래\n\n[[로스로리엔의 선물]]에서 받았다.',
        })
        const gift = await wiki.saveConfirmedTurn({
            characterId: 'project', chatId: 'chat',
            sourceMessageIds: ['gift-event'],
            markdown: '# 로스로리엔의 선물\n\n갈라드리엘이 가장 어두운 순간에 쓰라며 유리병을 건넸다.',
        })

        const inquiry = await wiki.inquire({
            characterId: 'project', chatId: 'chat',
            currentInput: '프로도가 쉘롭에게 공격당한다. 대항할 물건은 무엇인가?',
        })

        expect(inquiry.sources.some((source) =>
            source.id === `narrative-memory:wiki:${gift.relativePath}`)).toBe(true)
        expect(inquiry.metrics.hopCount).toBe(2)
    })

    test('always selects the current scene and excludes unrelated event notes', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        await wiki.saveConfirmedTurn({
            characterId: 'character',
            chatId: 'chat',
            sourceMessageIds: ['assistant-old'],
            markdown: '# 무관한 시장 사건\n\n상인이 사과를 팔았다.',
        })
        await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'character',
            title: '라비안',
            sourceMessageIds: ['assistant-new'],
            markdown: '# 라비안\n\n오른팔에 화상을 입었다.',
        })
        await wiki.saveCanonicalDocument({
            characterId: 'character',
            chatId: 'chat',
            type: 'scene',
            title: '현재 장면',
            sourceMessageIds: ['assistant-new'],
            markdown: '# 현재 장면\n\n일행은 소성당 안에 있다.',
        })

        const inquiry = await wiki.inquire({
            characterId: 'character',
            chatId: 'chat',
            currentInput: '라비안의 상태는?',
        })

        expect(inquiry.sources.map((source) => source.id)).toEqual([
            'narrative-memory:wiki:current-scene.md',
            expect.stringMatching(/^narrative-memory:wiki:characters\//),
        ])
        expect(inquiry.sources.some((source) =>
            source.id.includes('events/'))).toBe(false)
    })

    test('weights exact titles above newer body-only matches', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const titleMatch = await wiki.saveManualDocument({
            characterId: 'project', chatId: 'chat', type: 'location',
            title: '침수된 도서관', markdown: '# 침수된 도서관\n\n지하 서고가 폐쇄되었다.',
        })
        await wiki.saveManualDocument({
            characterId: 'project', chatId: 'chat', type: 'other',
            title: '최근 메모', markdown: '# 최근 메모\n\n침수된 도서관에 관한 일반적인 기록.',
        })

        const inquiry = await wiki.inquire({
            characterId: 'project', chatId: 'chat',
            currentInput: '침수된 도서관',
        })

        expect(inquiry.sources[0]?.id).toBe(
            `narrative-memory:wiki:${titleMatch.relativePath}`
        )
    })

    test('reports bounded dangling links and unlinked canonical pages', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const linked = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n[[없는 장소]]를 찾는다.',
        })
        const isolated = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'location',
            title: '고립된 탑', markdown: '# 고립된 탑\n\n아무 링크도 없다.',
        })

        const view = await wiki.loadView('character', 'chat')

        expect(view.health.danglingLinks).toEqual([{
            sourceId: linked.id,
            target: '없는 장소',
        }])
        expect(view.health.unlinkedDocumentIds).toEqual(expect.arrayContaining([
            linked.id,
            isolated.id,
        ]))
    })

    test('honors always and never context modes in bounded inquiry', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const pinned = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n항상 포함할 인물.',
        })
        const excluded = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'location',
            title: '금지된 탑', markdown: '# 금지된 탑\n\n비밀 장소.',
        })
        await wiki.setDocumentContextMode({
            characterId: 'character', chatId: 'chat',
            documentId: pinned.id, contextMode: 'always',
            expectedContentHash: pinned.contentHash,
        })
        await wiki.setDocumentContextMode({
            characterId: 'character', chatId: 'chat',
            documentId: excluded.id, contextMode: 'never',
            expectedContentHash: excluded.contentHash,
        })

        const inquiry = await wiki.inquire({
            characterId: 'character', chatId: 'chat',
            currentInput: '금지된 탑의 비밀',
        })

        expect(inquiry.sources.map((source) => source.id)).toEqual([
            `narrative-memory:wiki:${pinned.relativePath}`,
        ])
    })

    test('rejects stale canonical approvals and excessive required context', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const original = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n처음 상태.',
        })
        await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            type: 'character', title: '라비안',
            markdown: '# 라비안\n\n사용자가 고친 상태.',
            expectedContentHash: original.contentHash,
        })
        await expect(wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            type: 'character', title: '라비안',
            sourceMessageIds: ['assistant-1'],
            markdown: '# 라비안\n\n오래된 AI 초안.',
            expectedContentHash: original.contentHash,
        })).rejects.toThrow('Wiki document changed since the draft was created')

        for (let index = 0; index < 13; index += 1) {
            const page = await wiki.saveManualDocument({
                characterId: 'character', chatId: 'required', type: 'concept',
                title: `필수 ${index}`, markdown: `# 필수 ${index}\n\n설명.`,
            })
            await wiki.setDocumentContextMode({
                characterId: 'character', chatId: 'required',
                documentId: page.id, contextMode: 'always',
                expectedContentHash: page.contentHash,
            })
        }
        await expect(wiki.inquire({
            characterId: 'character', chatId: 'required', currentInput: '무관',
        })).rejects.toThrow('Required wiki context exceeds 12 documents')
    })

    test('keeps one review baseline across automatic canonical revisions', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const original = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'character',
            title: '라비안', markdown: '# 라비안\n\n검을 들고 있다.',
        })
        const first = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            type: 'character', title: '라비안', sourceMessageIds: ['turn-1'],
            markdown: '# 라비안\n\n창을 들고 있다.',
            expectedContentHash: original.contentHash,
            reviewStatus: 'unreviewed',
        })
        await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            type: 'character', title: '라비안', sourceMessageIds: ['turn-2'],
            markdown: '# 라비안\n\n은빛 창을 들고 있다.',
            expectedContentHash: first.contentHash,
            reviewStatus: 'unreviewed',
        })

        const current = (await wiki.loadView('character', 'chat')).documents
            .find((document) => document.id === original.id)
        expect(current).toMatchObject({
            reviewStatus: 'unreviewed',
            reviewBaseContent: '# 라비안\n\n검을 들고 있다.',
            content: '# 라비안\n\n은빛 창을 들고 있다.',
        })
    })

    test('accepts or reverts an unreviewed automatic canonical batch', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const original = await wiki.saveManualDocument({
            characterId: 'character', chatId: 'chat', type: 'item',
            title: '열쇠', markdown: '# 열쇠\n\n붉은 열쇠.',
        })
        const automatic = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            type: 'item', title: '열쇠', sourceMessageIds: ['turn-1'],
            markdown: '# 열쇠\n\n푸른 열쇠.',
            expectedContentHash: original.contentHash,
            reviewStatus: 'unreviewed',
        })
        const reverted = await wiki.reviewCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            action: 'revert', expectedContentHash: automatic.contentHash,
        })
        expect(reverted).toMatchObject({
            reviewStatus: 'reviewed',
            content: '# 열쇠\n\n붉은 열쇠.',
        })

        const next = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            type: 'item', title: '열쇠', sourceMessageIds: ['turn-2'],
            markdown: '# 열쇠\n\n금빛 열쇠.',
            expectedContentHash: reverted.contentHash,
            reviewStatus: 'unreviewed',
        })
        const accepted = await wiki.reviewCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: original.id,
            action: 'accept', expectedContentHash: next.contentHash,
        })
        expect(accepted).toMatchObject({
            reviewStatus: 'reviewed',
            content: '# 열쇠\n\n금빛 열쇠.',
        })
        expect(accepted.reviewBaseContent).toBeUndefined()
    })

    test('removes a newly created automatic canonical when reverted', async () => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-md-wiki-'))
        temporaryDirectories.push(root)
        const wiki = createMarkdownNarrativeWiki(root)
        const created = await wiki.saveCanonicalDocument({
            characterId: 'character', chatId: 'chat', type: 'scene',
            title: '현재 장면', sourceMessageIds: ['turn-1'],
            markdown: '# 현재 장면\n\n성문 앞에 도착했다.',
            reviewStatus: 'unreviewed',
        })
        await expect(wiki.reviewCanonicalDocument({
            characterId: 'character', chatId: 'chat', documentId: created.id,
            action: 'revert', expectedContentHash: created.contentHash,
        })).resolves.toEqual({
            id: created.id, reverted: true, deleted: true,
        })
        expect((await wiki.loadView('character', 'chat')).documents
            .some((document) => document.id === created.id)).toBe(false)
    })
})
