// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'

const mocks = vi.hoisted(() => ({
    review: vi.fn(async (input) => ({
        id: input.documentId, reviewStatus: 'reviewed',
    })),
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: vi.fn(async () => 'jwt') },
}))
vi.mock('src/ts/risubard/memoryWiki', () => ({
    reviewCanonicalWikiDocument: mocks.review,
}))

import RisuBardCanonicalAudit from './RisuBardCanonicalAudit.svelte'

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.clearAllMocks()
})

describe('RisuBardCanonicalAudit', () => {
    test('shows an unreviewed diff and accepts or reverts it', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const onChanged = vi.fn()
        mounted = mount(RisuBardCanonicalAudit, {
            target,
            props: {
                characterId: 'character', chatId: 'chat', onChanged,
                documents: [{
                    id: 'character.lavian', type: 'character', status: 'active',
                    title: '라비안', relativePath: 'characters/lavian.md',
                    sourceMessageIds: ['turn-1'], updated: '2026-08-11T00:00:00Z',
                    content: '# 라비안\n\n창을 든다.',
                    reviewBaseContent: '# 라비안\n\n검을 든다.',
                    reviewStatus: 'unreviewed', links: [], contextMode: 'auto',
                    contentHash: 'hash-current',
                }],
            },
        })
        expect(document.body.querySelector('[data-canonical-audit-count]')
            ?.textContent).toContain('1')
        expect(document.body.querySelector('[data-canonical-audit-before]')
            ?.textContent).toContain('검을 든다')
        expect(document.body.querySelector('[data-canonical-audit-after]')
            ?.textContent).toContain('창을 든다')

        document.body.querySelector<HTMLButtonElement>(
            '[data-canonical-audit-accept]'
        )!.click()
        await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledWith(
            expect.objectContaining({
                documentId: 'character.lavian', action: 'accept',
                expectedContentHash: 'hash-current',
            })
        ))
        await vi.waitFor(() => expect(onChanged).toHaveBeenCalledOnce())
    })
})
