// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import RisuBardWikiCommandTerminal from './RisuBardWikiCommandTerminal.svelte'

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('RisuBardWikiCommandTerminal', () => {
    test('runs one natural-language administrator command without workbench fields', async () => {
        const onExecute = vi.fn(async () => ({
            applied: [{
                action: 'upsert' as const,
                documentId: 'character.eri',
                title: '사토 에리',
                relativePath: 'characters/eri.md',
            }],
            failed: [],
        }))
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWikiCommandTerminal, {
            target,
            props: { onExecute },
        })

        expect(document.body.querySelector('[data-markdown-writer-new-title]'))
            .toBeNull()
        expect(document.body.querySelector('[data-markdown-writer-draft]'))
            .toBeNull()
        const input = document.body.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        input.value = '현 메시지의 프로파일 인물들을 각각 character로 만들어.'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const run = document.body.querySelector<HTMLButtonElement>(
            '[data-wiki-command-run]'
        )!
        await vi.waitFor(() => expect(run.disabled).toBe(false))
        run.click()

        await vi.waitFor(() => {
            expect(onExecute).toHaveBeenCalledWith(input.value)
            expect(document.body.querySelector('[data-wiki-command-result]')
                ?.textContent).toContain('사토 에리')
        })
    })

    test('shows every partial failure instead of a false success', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWikiCommandTerminal, {
            target,
            props: {
                onExecute: async () => ({
                    applied: [],
                    failed: [{
                        action: 'upsert' as const,
                        targetDocumentId: 'character.eri',
                        title: '사토 에리',
                        reason: '동시 편집 충돌',
                    }],
                }),
            },
        })
        const input = document.body.querySelector<HTMLTextAreaElement>(
            '[data-wiki-command-input]'
        )!
        input.value = '인물을 갱신해.'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        const run = document.body.querySelector<HTMLButtonElement>(
            '[data-wiki-command-run]'
        )!
        await vi.waitFor(() => expect(run.disabled).toBe(false))
        run.click()

        await vi.waitFor(() => expect(
            document.body.querySelector('[data-wiki-command-result]')?.textContent
        ).toContain('동시 편집 충돌'))
    })
})
