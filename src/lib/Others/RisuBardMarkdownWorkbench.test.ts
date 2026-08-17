// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'

const mocks = vi.hoisted(() => ({
    requestMarkdownWikiDraft: vi.fn(async () =>
        '# 라비안\n\n## 현재 상태\n\n오른팔에 화상을 입었다.'
    ),
    saveCanonicalWikiDocument: vi.fn(async () => ({
        id: 'character.lavian',
    })),
    requestChatData: vi.fn(),
}))

vi.mock('src/ts/process/request/request', () => ({
    requestChatData: mocks.requestChatData,
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: vi.fn(async () => 'jwt') },
}))
vi.mock('src/ts/risubard/markdownWikiWriter', () => ({
    requestMarkdownWikiDraft: mocks.requestMarkdownWikiDraft,
    saveCanonicalWikiDocument: mocks.saveCanonicalWikiDocument,
}))

import RisuBardMarkdownWorkbench from './RisuBardMarkdownWorkbench.svelte'

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.clearAllMocks()
})

describe('RisuBardMarkdownWorkbench', () => {
    test('drafts from selected evidence and saves only after approval', async () => {
        const onApplied = vi.fn()
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardMarkdownWorkbench, {
            target,
            props: {
                characterId: 'character',
                chatId: 'chat',
                targetId: 'character.lavian',
                documents: [{
                    id: 'character.lavian',
                    type: 'character',
                    status: 'active',
                    title: '라비안',
                    relativePath: 'characters/라비안.md',
                    sourceMessageIds: ['assistant-old'],
                    updated: '2026-08-08T00:00:00.000Z',
                    content: '# 라비안\n\n건강하다.',
                    links: [],
                    contextMode: 'auto',
                    contentHash: 'hash-lavian',
                }, {
                    id: 'event.turn',
                    type: 'event',
                    status: 'active',
                    title: '소성당 전투',
                    relativePath: 'events/turn.md',
                    sourceMessageIds: ['user-1', 'assistant-1'],
                    updated: '2026-08-08T01:00:00.000Z',
                    content: '# 소성당 전투\n\n라비안이 다쳤다.',
                    links: ['라비안'],
                    contextMode: 'auto',
                    contentHash: 'hash-event',
                }],
                onApplied,
            },
        })
        expect(document.body.querySelector('[data-markdown-writer-target-select]'))
            .toBeNull()
        expect(document.body.querySelector('[data-markdown-writer-target]')?.textContent)
            .toContain('라비안')
        const approve = document.body.querySelector<HTMLButtonElement>(
            '[data-markdown-writer-apply]'
        )!
        expect(approve.disabled).toBe(true)
        const instruction = document.body.querySelector<HTMLTextAreaElement>(
            '[data-markdown-writer-instruction]'
        )!
        instruction.value = '전투 이후 현재 상태를 갱신해.'
        instruction.dispatchEvent(new Event('input', { bubbles: true }))
        const draftButton = document.body.querySelector<HTMLButtonElement>(
            '[data-markdown-writer-draft]'
        )!
        await vi.waitFor(() => expect(draftButton.disabled).toBe(false))
        draftButton.click()

        await vi.waitFor(() => {
            expect(mocks.requestMarkdownWikiDraft).toHaveBeenCalledOnce()
            expect(approve.disabled).toBe(false)
        })
        approve.click()

        await vi.waitFor(() => {
            expect(mocks.saveCanonicalWikiDocument).toHaveBeenCalledWith(
                expect.objectContaining({
                    documentId: 'character.lavian',
                    expectedContentHash: 'hash-lavian',
                    sourceMessageIds: ['user-1', 'assistant-1'],
                })
            )
            expect(onApplied).toHaveBeenCalledOnce()
        })
    })

    test('starts with a new document and clears a sent target with the remove button', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardMarkdownWorkbench, {
            target,
            props: {
                characterId: 'character',
                chatId: 'chat',
                targetId: 'character.lavian',
                documents: [{
                    id: 'character.lavian',
                    type: 'character',
                    status: 'active',
                    title: '라비안',
                    relativePath: 'characters/라비안.md',
                    sourceMessageIds: [],
                    updated: '2026-08-08T00:00:00.000Z',
                    content: '# 라비안',
                    links: [],
                    contextMode: 'auto',
                    contentHash: 'hash-lavian',
                }],
            },
        })

        const clear = document.body.querySelector<HTMLButtonElement>(
            '[data-markdown-writer-clear-target]'
        )
        expect(clear).not.toBeNull()
        clear?.click()

        await vi.waitFor(() => {
            expect(document.body.querySelector('[data-markdown-writer-target]')?.textContent)
                .not.toContain('라비안')
            expect(document.body.querySelector<HTMLInputElement>(
                '[data-markdown-writer-new-title]'
            )).not.toBeNull()
        })
    })
})
