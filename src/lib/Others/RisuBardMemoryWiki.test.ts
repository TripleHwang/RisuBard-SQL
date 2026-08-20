// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'

const mocks = vi.hoisted(() => ({
    loadNarrativeMemoryWiki: vi.fn(),
    saveManualWikiDocument: vi.fn(),
    replaceWikiText: vi.fn(),
    saveChatToServer: vi.fn(),
    db: {} as {
        risuBardMemoryDialogSize?: {
            width: number
            height: number
        }
        risuBardMemoryDockRatio?: number
        risuBardMemoryWorkspaceHeight?: number
        risuBardModelMode?: 'memory' | 'model'
        risuBardRecentMessageCount?: number
        risuBardResponseMessageCount?: number
        risuBardResponseIncludeUserMessages?: boolean
        characters?: Array<{
            chaId: string
            reloadKeys?: number
            chats: Array<{
                id: string
                isStreaming?: boolean
                message: Array<{
                    role: 'user' | 'char'
                    data: string
                    swipes?: string[]
                }>
            }>
        }>
    },
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        createAuth: vi.fn(async () => 'auth-token'),
    },
    saveAsset: vi.fn(async () => ''),
}))
vi.mock('src/ts/process/request/request', () => ({
    requestChatData: vi.fn(),
}))
vi.mock('src/ts/risubard/memoryWiki', () => ({
    loadNarrativeMemoryWiki: mocks.loadNarrativeMemoryWiki,
    saveManualWikiDocument: mocks.saveManualWikiDocument,
}))
vi.mock('src/ts/risubard/findReplace', () => ({
    previewFindReplace: (
        documents: Array<{ title: string; content: string }>,
        messages: Array<{ data: string; swipes?: string[] }>,
        find: string
    ) => {
        const count = (value: string) => find
            ? value.split(find).length - 1
            : 0
        return {
            wikiMatches: documents.reduce((total, item) =>
                total + count(item.content), 0),
            wikiDocuments: documents.filter((item) =>
                count(item.content) > 0).length,
            chatMatches: messages.reduce((total, item) => total
                + count(item.data)
                + (item.swipes ?? []).reduce((sum, swipe) =>
                    sum + count(swipe), 0), 0),
            chatMessages: messages.filter((item) => count(item.data)
                + (item.swipes ?? []).reduce((sum, swipe) =>
                    sum + count(swipe), 0) > 0).length,
        }
    },
    applyChatFindReplace: (
        messages: Array<{ data: string; swipes?: string[] }>,
        find: string,
        replacement: string
    ) => {
        let matches = 0
        let changedMessages = 0
        for (const message of messages) {
            let current = message.data.split(find).length - 1
            message.data = message.data.replaceAll(find, replacement)
            message.swipes = message.swipes?.map((swipe) => {
                current += swipe.split(find).length - 1
                return swipe.replaceAll(find, replacement)
            })
            if (current > 0) changedMessages += 1
            matches += current
        }
        return { matches, messages: changedMessages }
    },
    replaceWikiText: mocks.replaceWikiText,
}))
vi.mock('src/ts/storage/chatStorage', () => ({
    saveChatToServer: mocks.saveChatToServer,
}))
vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: mocks.db },
    selIdState: { selId: -1 },
}))

import RisuBardMemoryWiki from './RisuBardMemoryWiki.svelte'

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.clearAllMocks()
    delete mocks.db.risuBardMemoryDialogSize
    delete mocks.db.risuBardMemoryDockRatio
    delete mocks.db.risuBardMemoryWorkspaceHeight
    delete mocks.db.risuBardModelMode
    delete mocks.db.risuBardRecentMessageCount
    delete mocks.db.risuBardResponseMessageCount
    delete mocks.db.risuBardResponseIncludeUserMessages
    delete mocks.db.characters
})

describe('RisuBardMemoryWiki', () => {
    test('opens detailed Memory Wiki help from the title row', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown',
            wikiPath: 'C:\\wiki',
            health: { danglingLinks: [], unlinkedDocumentIds: [] },
            documents: [],
        })
        mounted = mount(RisuBardMemoryWiki, {
            target: document.body,
            props: { open: true, characterId: 'character', chatId: 'chat' },
        })

        let helpButton: HTMLButtonElement | null = null
        await vi.waitFor(() => {
            helpButton = document.querySelector('[data-memory-help]')
            expect(helpButton).not.toBeNull()
        })
        expect(document.body.textContent).not.toContain(
            '현재 메모리를 살펴보고 명시적인 작가 변경을 준비할 수 있습니다.'
        )
        expect(helpButton?.previousElementSibling?.tagName).toBe('STRONG')

        helpButton?.click()
        await vi.waitFor(() => {
            const help = document.querySelector('[data-memory-help-content]')
            expect(help).not.toBeNull()
            expect(help?.textContent).toContain('자동 분석과 추가 분석')
            expect(help?.textContent).toContain('문서 편집과 안전장치')
            expect(help?.textContent).toContain('위키 관리자 명령')
            expect(help?.textContent).toContain('컨텍스트 정책')
        })
    })

    test('coordinates the portrait command panel with editor focus mode', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown',
            wikiPath: 'C:\\wiki',
            health: { danglingLinks: [], unlinkedDocumentIds: [] },
            documents: [],
        })
        mounted = mount(RisuBardMemoryWiki, {
            target: document.body,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
                onExecuteWikiCommand: async () => ({ applied: [], failed: [] }),
            },
        })

        let dock: HTMLElement | null = null
        let commandPane: HTMLElement | null = null
        await vi.waitFor(() => {
            dock = document.querySelector('[data-memory-wiki-dock]')
            commandPane = document.querySelector('[data-wiki-command-pane]')
            expect(dock).not.toBeNull()
            expect(commandPane).not.toBeNull()
        })
        expect(commandPane?.dataset.commandExpanded).toBe('false')
        expect(dock?.dataset.editorFocus).toBe('false')

        document.querySelector<HTMLButtonElement>(
            '[data-wiki-toggle-command]'
        )?.click()
        await tick()
        expect(commandPane?.dataset.commandExpanded).toBe('true')

        document.querySelector<HTMLButtonElement>(
            '[data-wiki-editor-focus]'
        )?.click()
        await tick()
        expect(dock?.dataset.editorFocus).toBe('true')
    })

    test('replaces text across the wiki and persisted current chat', async () => {
        const original = {
            id: 'character.gilbert', type: 'character' as const,
            status: 'active' as const, title: '길버드',
            relativePath: 'characters/gilbert.md', sourceMessageIds: [],
            updated: 'now', content: '# 길버드\n\n길버드가 웃었다.', links: [],
            contextMode: 'auto' as const, contentHash: 'old-hash',
        }
        const updated = {
            ...original, title: '길버트',
            content: '# 길버트\n\n길버트가 웃었다.', contentHash: 'new-hash',
        }
        const view = (document: typeof original) => ({
            mode: 'markdown' as const, wikiPath: 'C:\\wiki',
            documents: [document],
            health: { danglingLinks: [], unlinkedDocumentIds: [] },
        })
        mocks.loadNarrativeMemoryWiki
            .mockResolvedValueOnce(view(original))
            .mockResolvedValueOnce(view(updated))
        mocks.replaceWikiText.mockResolvedValue({ matches: 2, documents: 1 })
        mocks.saveChatToServer.mockResolvedValue(undefined)
        mocks.db.characters = [{
            chaId: 'character', reloadKeys: 0,
            chats: [{
                id: 'chat',
                message: [{
                    role: 'char', data: '길버드가 왔다.',
                    swipes: ['길버드가 왔다.'],
                }],
            }],
        }]
        mounted = mount(RisuBardMemoryWiki, {
            target: document.body,
            props: { open: true, characterId: 'character', chatId: 'chat' },
        })

        await vi.waitFor(() => {
            const toolbarButton = document.querySelector(
                '.dock-header [data-memory-view="replace"]'
            )
            expect(toolbarButton).not.toBeNull()
            expect(toolbarButton?.querySelector('svg')).not.toBeNull()
        })
        document.querySelector<HTMLButtonElement>(
            '[data-memory-view="replace"]'
        )?.click()
        await vi.waitFor(() => expect(document.querySelector(
            '[data-find-replace]'
        )).not.toBeNull())
        const find = document.querySelector<HTMLInputElement>(
            '[data-find-replace-find]'
        )!
        const replacement = document.querySelector<HTMLInputElement>(
            '[data-find-replace-replacement]'
        )!
        find.value = '길버드'
        find.dispatchEvent(new Event('input', { bubbles: true }))
        replacement.value = '길버트'
        replacement.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        document.querySelector<HTMLButtonElement>(
            '[data-find-replace-run]'
        )?.click()

        await vi.waitFor(() => expect(mocks.replaceWikiText)
            .toHaveBeenCalledWith(expect.objectContaining({
                characterId: 'character', chatId: 'chat',
                find: '길버드', replacement: '길버트',
            })))
        await vi.waitFor(() => expect(mocks.saveChatToServer)
            .toHaveBeenCalledOnce())
        expect(mocks.db.characters[0].chats[0].message[0]).toMatchObject({
            data: '길버트가 왔다.', swipes: ['길버트가 왔다.'],
        })
        expect(mocks.db.characters[0].reloadKeys).toBe(1)
    })

    test('shows a command-updated document without creating a false local edit', async () => {
        const original = {
            id: 'character.amanda', type: 'character' as const,
            status: 'active' as const, title: '아만다 다인',
            relativePath: 'characters/amanda.md', sourceMessageIds: [],
            updated: 'now', content: '# 아만다 다인\n\n기존 정보.', links: [],
            contextMode: 'auto' as const, contentHash: 'amanda-old',
        }
        const updated = {
            ...original,
            content: '# 아만다 다인\n\n기존 정보. 추가된 비밀 정보.',
            contentHash: 'amanda-new',
        }
        const view = (document: typeof original) => ({
            mode: 'markdown' as const,
            wikiPath: 'C:\\wiki',
            documents: [document],
            health: { danglingLinks: [], unlinkedDocumentIds: [] },
        })
        mocks.loadNarrativeMemoryWiki
            .mockResolvedValueOnce(view(original))
            .mockResolvedValueOnce(view(updated))
        const onExecuteWikiCommand = vi.fn(async () => ({
            applied: [{
                action: 'upsert' as const,
                documentId: original.id,
                title: original.title,
                relativePath: original.relativePath,
            }],
            failed: [],
        }))
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
                onExecuteWikiCommand,
            },
        })

        await vi.waitFor(() => expect(
            document.querySelector<HTMLTextAreaElement>('[aria-label="Markdown"]')
                ?.value
        ).toBe(original.content))
        const command = document.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        command.value = '아만다 다인에 비밀 정보를 추가해.'
        command.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        document.querySelector<HTMLButtonElement>('[data-wiki-command-run]')
            ?.click()

        await vi.waitFor(() => expect(
            mocks.loadNarrativeMemoryWiki
        ).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(
            document.querySelector<HTMLTextAreaElement>('[aria-label="Markdown"]')
                ?.value
        ).toBe(updated.content))
        expect(document.body.textContent).not.toContain('저장하지 않은 변경')
    })

    test('keeps the selected document and file-tree viewport after saving', async () => {
        const first = {
            id: 'character.first', type: 'character' as const,
            status: 'active' as const, title: '첫 번째',
            relativePath: 'characters/first.md', sourceMessageIds: [],
            updated: 'now', content: '# 첫 번째\n\n첫 문서.', links: [],
            contextMode: 'auto' as const, contentHash: 'first-hash',
        }
        const second = {
            id: 'character.second', type: 'character' as const,
            status: 'active' as const, title: '두 번째',
            relativePath: 'characters/second.md', sourceMessageIds: [],
            updated: 'now', content: '# 두 번째\n\n둘째 문서.', links: [],
            contextMode: 'auto' as const, contentHash: 'second-hash',
        }
        const savedSecond = {
            ...second, content: '# 두 번째\n\n수정한 둘째 문서.',
            contentHash: 'second-hash-next',
        }
        const view = (documents: typeof first[]) => ({
            mode: 'markdown' as const, wikiPath: 'C:\\wiki', documents,
            health: { danglingLinks: [], unlinkedDocumentIds: [] },
        })
        mocks.loadNarrativeMemoryWiki
            .mockResolvedValueOnce(view([first, second]))
            .mockResolvedValueOnce(view([first, savedSecond]))
        mocks.saveManualWikiDocument.mockResolvedValue(savedSecond)
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: { open: true, characterId: 'character', chatId: 'chat' },
        })

        await vi.waitFor(() => expect(
            document.querySelector('[data-wiki-editor]')
        ).not.toBeNull())
        const secondButton = [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === '두 번째')!
        secondButton.click()
        await tick()
        const tree = document.querySelector<HTMLElement>('.file-tree')!
        tree.scrollTop = 120
        const markdown = document.querySelector<HTMLTextAreaElement>(
            '[aria-label="Markdown"]'
        )!
        markdown.value = savedSecond.content
        markdown.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        const save = [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === '저장')!
        save.click()

        await vi.waitFor(() => expect(
            mocks.loadNarrativeMemoryWiki
        ).toHaveBeenCalledTimes(2))
        await vi.waitFor(() => expect(
            document.querySelector<HTMLInputElement>('[aria-label="항목 이름"]')
                ?.value
        ).toBe('두 번째'))
        expect(document.querySelector('.file-tree')).toBe(tree)
        expect(tree.scrollTop).toBe(120)
    })

    test('shows the concrete force-update failure reason', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown', wikiPath: 'C:\\wiki', documents: [],
        })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
                onForceWikiUpdate: async () => {
                    throw new Error('위키 조회 제한 시간을 초과했습니다.')
                },
            },
        })

        let button: HTMLButtonElement | null = null
        await vi.waitFor(() => {
            button = document.body.querySelector(
                '[data-risubard-force-wiki-update]'
            )
            expect(button).not.toBeNull()
        })
        button?.click()

        await vi.waitFor(() => {
            expect(document.body.textContent).toContain(
                '위키 조회 제한 시간을 초과했습니다.'
            )
        })
    })

    test('keeps chat history policy out of the wiki settings menu', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown',
            wikiPath: 'C:\\wiki',
            documents: [],
        })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: { open: true, characterId: 'character', chatId: 'chat' },
        })

        await vi.waitFor(() => {
            expect(document.body.querySelector('[data-memory-settings]')).not.toBeNull()
        })
        expect(document.body.querySelector('[data-memory-recent-message-count]')).toBeNull()
        expect(document.body.querySelector('[data-response-recent-message-count]')).toBeNull()
        expect(document.body.querySelector('[data-response-include-user-messages]')).toBeNull()
    })

    test('uses one compact top navigation and moves document count into the sidebar', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown',
            wikiPath: 'C:\\Users\\reader\\RisuBard\\wiki',
            health: { danglingLinks: [], unlinkedDocumentIds: [] },
            documents: [{
                id: 'character.reader', type: 'character', status: 'active',
                title: 'Reader', relativePath: 'characters/reader.md',
                sourceMessageIds: [], updated: 'now', content: '# Reader',
                links: [], contextMode: 'auto', contentHash: 'hash',
            }],
        })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
            },
        })

        await vi.waitFor(() => {
            const views = document.body.querySelector('.dock-views')
            expect(views).not.toBeNull()
            expect(views?.querySelector('[data-risubard-force-wiki-update]'))
                .not.toBeNull()
            expect(views?.querySelector('[data-memory-settings]')).not.toBeNull()
            expect(document.body.querySelector('[data-wiki-editor-menu]')).toBeNull()
            expect(document.body.querySelector('.ledger-toolbar')).toBeNull()
            expect(document.body.querySelector('.wiki-health')?.textContent)
                .toMatch(/1\s*문서.*끊어진 링크 0/)
            expect(document.body.textContent).not.toContain('Markdown 원본')
            expect(document.body.textContent).not.toContain(
                'C:\\Users\\reader\\RisuBard\\wiki'
            )
        })

        const forceUpdate = document.body.querySelector(
            '[data-risubard-force-wiki-update]'
        )!
        const workspace = document.body.querySelector('[data-memory-view="workspace"]')!
        const log = document.body.querySelector('[data-memory-view="log"]')!
        const settings = document.body.querySelector('[data-memory-settings]')!
        expect(forceUpdate.compareDocumentPosition(workspace)
            & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
        expect(log.compareDocumentPosition(settings)
            & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
    })

    test('shows the current v2 graph instead of the v1 ledger', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'v2',
            baseline: null,
            graph: {
                schemaVersion: 2,
                storyId: 'character',
                branchId: 'chat',
                revision: 1,
                nodes: [{
                    id: 'entity:lina',
                    kind: 'entity',
                    subtype: 'character',
                    title: 'Lina',
                    summary: 'Lina summary',
                    storyId: 'character',
                    branchId: 'chat',
                    status: 'active',
                    authority: 'draft',
                    salience: 5,
                    perspective: { kind: 'omniscient' },
                    epistemic: 'fact',
                    evidence: [{
                        chatId: 'chat',
                        messageId: 'message-1',
                    }],
                    revision: 1,
                }],
                edges: [],
            },
        })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
            },
        })

        await vi.waitFor(() => {
            expect(mocks.loadNarrativeMemoryWiki).toHaveBeenCalledOnce()
            expect(document.body.querySelector(
                '[data-memory-node-id="entity:lina"]'
            )).not.toBeNull()
            expect(document.body.querySelector(
                '[data-writer-workbench]'
            )).not.toBeNull()
            expect(document.body.querySelector(
                '[data-memory-v2-scroll]'
            )).not.toBeNull()
            expect(document.body.querySelector('[data-memory-wiki-dock]'))
                .not.toBeNull()
            expect(document.body.querySelector('[role="dialog"]')).toBeNull()
            const ledger = document.body.querySelector<HTMLElement>(
                '.memory-ledger'
            )
            expect(ledger?.classList.contains('min-h-0')).toBe(true)
        })
        await tick()
    })

    test('announces the safe v1 compatibility view when graph cache is unavailable', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'v1',
            reason: 'missing-or-stale-v2-index',
            baseline: null,
            state: {
                facts: [],
                events: [],
            },
        })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
            },
        })

        await vi.waitFor(() => {
            const fallback = document.body.querySelector(
                '[data-memory-view-mode="v1"]'
            )
            expect(fallback).not.toBeNull()
            expect(fallback?.textContent).toContain('Compatibility view')
            expect(document.body.querySelector(
                '[data-writer-workbench]'
            )).toBeNull()
        })
    })

    test('reloads an open empty view when its background analysis completes', async () => {
        mocks.loadNarrativeMemoryWiki
            .mockResolvedValueOnce({
                mode: 'v1',
                reason: 'missing-or-stale-v2-index',
                baseline: null,
                state: { facts: [], events: [] },
            })
            .mockResolvedValueOnce({
                mode: 'v2',
                baseline: null,
                graph: {
                    schemaVersion: 2,
                    storyId: 'character',
                    branchId: 'chat',
                    revision: 1,
                    nodes: [{
                        id: 'entity:first-turn',
                        kind: 'entity',
                        subtype: 'character',
                        title: 'First turn',
                        summary: 'The first turn.',
                        storyId: 'character',
                        branchId: 'chat',
                        status: 'active',
                        authority: 'draft',
                        salience: 3,
                        perspective: { kind: 'omniscient' },
                        epistemic: 'fact',
                        evidence: [{
                            chatId: 'chat',
                            messageId: 'message-1',
                        }],
                        revision: 1,
                    }],
                    edges: [],
                },
            })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
            },
        })
        await vi.waitFor(() => {
            expect(mocks.loadNarrativeMemoryWiki).toHaveBeenCalledOnce()
            expect(document.body.querySelector(
                '[data-memory-view-mode="v1"]'
            )).not.toBeNull()
        })

        window.dispatchEvent(new CustomEvent('risubard-memory-updated', {
            detail: {
                characterId: 'character',
                chatId: 'chat',
            },
        }))

        await vi.waitFor(() => {
            expect(mocks.loadNarrativeMemoryWiki).toHaveBeenCalledTimes(2)
            expect(document.body.querySelector(
                '[data-memory-node-id="entity:first-turn"]'
            )).not.toBeNull()
        })
    })

    test('restores the dock ratio without fixed layout preset controls', async () => {
        mocks.db.risuBardMemoryDockRatio = 0.5
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown',
            wikiPath: 'C:\\wiki',
            documents: [],
        })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
            },
        })

        await vi.waitFor(() => {
            const dock = document.body.querySelector<HTMLElement>(
                '[data-memory-wiki-dock]'
            )
            expect(dock?.style.flexBasis).toBe('50%')
        })
        expect(document.body.querySelector('[data-memory-layout-preset]'))
            .toBeNull()
    })

    test('restores and keyboard-resizes the wiki editor and command split', async () => {
        mocks.db.risuBardMemoryWorkspaceHeight = 460
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown',
            wikiPath: 'C:\\wiki',
            documents: [],
        })
        mounted = mount(RisuBardMemoryWiki, {
            target: document.body,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
                onExecuteWikiCommand: async () => ({ applied: [], failed: [] }),
            },
        })

        let split: HTMLElement | null = null
        let resizer: HTMLButtonElement | null = null
        await vi.waitFor(() => {
            split = document.querySelector('[data-wiki-workspace-split]')
            resizer = document.querySelector('[data-wiki-workspace-resizer]')
            expect(split).not.toBeNull()
            expect(resizer).not.toBeNull()
        })
        if (!split || !resizer) throw new Error('Workspace split was not rendered')
        expect(split.style.getPropertyValue('--wiki-workspace-height')).toBe('460px')

        resizer.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowDown',
            bubbles: true,
        }))
        await vi.waitFor(() => {
            expect(mocks.db.risuBardMemoryWorkspaceHeight).toBe(484)
            expect(split?.style.getPropertyValue('--wiki-workspace-height'))
                .toBe('484px')
        })
    })

    test('stores whether RisuBard uses the helper or main model', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown', wikiPath: 'C:\\wiki', documents: [],
        })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: { open: true, characterId: 'character', chatId: 'chat' },
        })

        let select: HTMLSelectElement | null = null
        await vi.waitFor(() => {
            select = document.body.querySelector('[data-memory-model-mode]')
            expect(select).not.toBeNull()
        })
        if (!select) throw new Error('Model mode setting was not rendered')
        expect(select.value).toBe('memory')
        select.value = 'model'
        select.dispatchEvent(new Event('change', { bubbles: true }))
        await vi.waitFor(() => {
            expect(mocks.db.risuBardModelMode).toBe('model')
        })
    })

    test('keeps documents and the direct command terminal together while logs use a separate view', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown',
            wikiPath: 'C:\\wiki',
            documents: [],
        })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardMemoryWiki, {
            target,
            props: {
                open: true,
                characterId: 'character',
                chatId: 'chat',
                onExecuteWikiCommand: async () => ({ applied: [], failed: [] }),
            },
        })

        await vi.waitFor(() => {
            expect(document.body.querySelector('[data-wiki-editor]')).not.toBeNull()
            expect(document.body.querySelector('[data-wiki-command-terminal]')).not.toBeNull()
            expect(document.body.querySelector('[data-memory-activity]')).toBeNull()
        })
        document.body.querySelector<HTMLButtonElement>(
            '[data-memory-view="log"]'
        )?.click()
        await vi.waitFor(() => {
            expect(document.body.querySelector('[data-memory-activity]')).not.toBeNull()
            expect(document.body.querySelector('[data-wiki-editor]')).toBeNull()
        })
    })

    test('opens the shared story view and delegates source navigation', async () => {
        mocks.loadNarrativeMemoryWiki.mockResolvedValue({
            mode: 'markdown', wikiPath: 'C:\\wiki',
            health: { danglingLinks: [], unlinkedDocumentIds: [] },
            documents: [{
                id: 'event.station', type: 'event', status: 'active',
                title: '폐쇄된 역', relativePath: 'events/station.md',
                sourceMessageIds: ['message-7'],
                created: '2026-08-15T00:00:00.000Z',
                updated: '2026-08-15T00:00:00.000Z',
                content: '# 폐쇄된 역\n\n## 이야기 요약\n\n- 폐쇄된 역에 도착했다.',
                links: [], contextMode: 'auto', contentHash: 'hash',
            }],
        })
        const onNavigateStorySource = vi.fn()
        mounted = mount(RisuBardMemoryWiki, {
            target: document.body,
            props: {
                open: true, characterId: 'character', chatId: 'chat',
                onNavigateStorySource,
            },
        })
        await vi.waitFor(() => expect(document.querySelector(
            '[data-memory-view="story"]'
        )).not.toBeNull())
        document.querySelector<HTMLButtonElement>(
            '[data-memory-view="story"]'
        )?.click()
        await vi.waitFor(() => expect(document.querySelector(
            '[data-story-entry="event.station"]'
        )).not.toBeNull())
        document.querySelector<HTMLButtonElement>(
            '[data-story-entry="event.station"]'
        )?.click()
        expect(onNavigateStorySource).toHaveBeenCalledWith({
            kind: 'chat', messageIds: ['message-7'],
        })
    })
})
