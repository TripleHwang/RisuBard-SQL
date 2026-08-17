// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'

const mocks = vi.hoisted(() => ({
    requestBatch: vi.fn(async () => [{
        documentId: 'character.lavian', type: 'character', title: '라비안',
        markdown: '# 라비안\n\n갱신.', contentHash: 'hash-lavian',
    }]),
    save: vi.fn(async () => ({ id: 'character.lavian' })),
    requestChatData: vi.fn(),
}))

vi.mock('src/ts/process/request/request', () => ({ requestChatData: mocks.requestChatData }))
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: vi.fn(async () => 'jwt') },
}))
vi.mock('src/ts/risubard/markdownWikiWriter', () => ({
    requestIsolatedMarkdownWikiBatchDrafts: mocks.requestBatch,
    saveCanonicalWikiDocument: mocks.save,
}))

import RisuBardWikiBatchDrafts from './RisuBardWikiBatchDrafts.svelte'

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.clearAllMocks()
})

describe('RisuBardWikiBatchDrafts', () => {
    test('creates review cards and saves only an individually approved draft', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWikiBatchDrafts, {
            target,
            props: {
                characterId: 'character', chatId: 'chat',
                documents: [{
                    id: 'character.lavian', type: 'character', status: 'active',
                    title: '라비안', relativePath: 'characters/라비안.md',
                    sourceMessageIds: [], updated: '2026-08-09T00:00:00.000Z',
                    content: '# 라비안', links: [], contextMode: 'auto',
                    contentHash: 'hash-lavian',
                }, {
                    id: 'event.turn', type: 'event', status: 'active',
                    title: '전투', relativePath: 'events/turn.md',
                    sourceMessageIds: ['assistant-1'], updated: '2026-08-09T00:00:00.000Z',
                    content: '# 전투', links: [], contextMode: 'auto',
                    contentHash: 'hash-event',
                }],
            },
        })
        document.body.querySelector<HTMLInputElement>('[data-wiki-batch-target]')!.click()
        const instruction = document.body.querySelector<HTMLTextAreaElement>('[data-wiki-batch-instruction]')!
        instruction.value = '상태를 갱신해.'
        instruction.dispatchEvent(new Event('input', { bubbles: true }))
        const create = document.body.querySelector<HTMLButtonElement>('[data-wiki-batch-create]')!
        await vi.waitFor(() => expect(create.disabled).toBe(false))
        create.click()
        await vi.waitFor(() => expect(mocks.requestBatch).toHaveBeenCalledOnce())
        expect(mocks.save).not.toHaveBeenCalled()
        await vi.waitFor(() => expect(
            document.body.querySelector('[data-wiki-batch-review]')
        ).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-wiki-batch-approve]')!.click()
        await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledWith(
            expect.objectContaining({
                documentId: 'character.lavian',
                expectedContentHash: 'hash-lavian',
            })
        ))
    })
})
