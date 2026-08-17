// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import RisuBardFindReplace from './RisuBardFindReplace.svelte'

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('RisuBardFindReplace', () => {
    test('previews both scopes and submits one explicit replacement', async () => {
        const onReplace = vi.fn(async () => ({
            wikiMatches: 2, wikiDocuments: 1,
            chatMatches: 2, chatMessages: 1,
        }))
        mounted = mount(RisuBardFindReplace, {
            target: document.body,
            props: {
                documents: [{
                    id: 'character.gilbert', title: '길버드',
                    content: '# 길버드\n\n길버드가 웃었다.',
                }],
                messages: [{
                    role: 'char', data: '길버드가 왔다.',
                    swipes: ['길버드가 왔다.'],
                }],
                onReplace,
            },
        })

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

        expect(document.body.textContent).toContain('위키 2곳 · 1개 문서')
        expect(document.body.textContent).toContain('챗 2곳 · 1개 메시지')
        expect(document.body.textContent).toContain('이력을 추가하지 않습니다')
        document.querySelector<HTMLButtonElement>(
            '[data-find-replace-run]'
        )?.click()

        await vi.waitFor(() => expect(onReplace).toHaveBeenCalledWith({
            find: '길버드', replacement: '길버트', wiki: true, chat: true,
        }))
        await vi.waitFor(() => expect(document.body.textContent)
            .toContain('4곳을 바꿨습니다'))
    })
})
