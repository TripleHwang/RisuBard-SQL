import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { Chat } from 'src/ts/storage/database.svelte'
import ChatMergeDialog from './ChatMergeDialog.svelte'

let mounted: ReturnType<typeof mount> | undefined
afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})
const chats: Chat[] = ['1부', '2부', '3부'].map((name, i) => ({
    id: String(i), name, note: '', localLore: [],
    message: [{ role: 'char', data: `${name} 마지막 대화`, chatId: `m${i}` }],
}))
function render(options: { loadChat?: (id: string) => Promise<Chat>; onMerge?: (ids: string[], name: string) => Promise<void> } = {}) {
    const onMerge = options.onMerge ?? vi.fn(async () => undefined)
    const onOpenChange = vi.fn()
    mounted = mount(ChatMergeDialog, {
        target: document.body.appendChild(document.createElement('div')),
        props: { chats, open: true, onOpenChange, onMerge,
            loadChat: options.loadChat ?? (async id => chats.find(c => c.id === id)!) },
    })
    return { onMerge, onOpenChange }
}
const button = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!
async function add(id: string) {
    button(`[data-merge-add="${id}"]`).click()
    await vi.waitFor(() => expect(document.querySelector(`[data-merge-row="${id}"]`)?.textContent).toContain('마지막 대화'))
}

describe('ChatMergeDialog', () => {
    test('requires two chats and submits only the explicitly arranged order', async () => {
        const { onMerge } = render()
        await tick()
        expect(button('[data-merge-submit]').disabled).toBe(true)
        await add('0')
        expect(button('[data-merge-submit]').disabled).toBe(true)
        await add('1')
        button('[data-merge-up="1"]').click()
        await tick()
        expect([...document.querySelectorAll('[data-merge-row]')].map(e => e.getAttribute('data-merge-row'))).toEqual(['1', '0'])
        const input = document.querySelector<HTMLInputElement>('[data-merge-name]')!
        input.value = '내 이야기'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        button('[data-merge-submit]').click()
        await vi.waitFor(() => expect(onMerge).toHaveBeenCalledWith(['1', '0'], '내 이야기'))
        expect(document.body.textContent).toContain('원본 챗')
    })

    test('removing a selection restores it to the available list without changing original order', async () => {
        render()
        await tick()
        await add('0'); await add('1')
        button('[data-merge-remove="0"]').click()
        await tick()
        expect(document.querySelector('[data-merge-row="0"]')).toBeNull()
        expect(button('[data-merge-add="0"]')).not.toBeNull()
        expect(chats.map(c => c.id)).toEqual(['0', '1', '2'])
        expect(button('[data-merge-submit]').disabled).toBe(true)
    })

    test('requires acknowledgement for shared message IDs and never silently deduplicates', async () => {
        const { onMerge } = render({ loadChat: async id => ({ ...chats[Number(id)], message: chats[0].message }) })
        await tick()
        await add('0'); await add('1')
        expect(button('[data-merge-submit]').disabled).toBe(true)
        expect(document.body.textContent).toContain('겹치는 메시지')
        document.querySelector<HTMLInputElement>('[data-merge-overlap]')!.click()
        await tick()
        button('[data-merge-submit]').click()
        await vi.waitFor(() => expect(onMerge).toHaveBeenCalled())
    })

    test('shows load failures and prevents creating an incomplete chat', async () => {
        render({ loadChat: async () => { throw new Error('load failed') } })
        await tick()
        button('[data-merge-add="0"]').click()
        await vi.waitFor(() => expect(document.body.textContent).toContain('load failed'))
        expect(button('[data-merge-submit]').disabled).toBe(true)
    })

    test('keeps the window open on save failure and prevents double submission', async () => {
        let rejectSave!: (error: Error) => void
        const onMerge = vi.fn(() => new Promise<void>((_, reject) => { rejectSave = reject }))
        const { onOpenChange } = render({ onMerge })
        await tick()
        await add('0'); await add('1')
        button('[data-merge-submit]').click()
        await tick()
        expect(button('[data-merge-submit]').disabled).toBe(true)
        rejectSave(new Error('disk full'))
        await vi.waitFor(() => expect(document.body.textContent).toContain('disk full'))
        expect(onOpenChange).not.toHaveBeenCalledWith(false)
        expect(onMerge).toHaveBeenCalledOnce()
    })

    test('ignores a stale load failure after removing and reselecting a chat', async () => {
        let rejectFirst!: (error: Error) => void
        let loads = 0
        render({ loadChat: id => {
            if (++loads === 1) return new Promise((_, reject) => { rejectFirst = reject })
            return Promise.resolve(chats[Number(id)])
        } })
        await tick()
        button('[data-merge-add="0"]').click()
        await tick()
        button('[data-merge-remove="0"]').click()
        await tick()
        await add('0'); await add('1')
        rejectFirst(new Error('stale request'))
        await new Promise(resolve => setTimeout(resolve, 0))
        await tick()
        expect(document.body.textContent).not.toContain('stale request')
        expect(button('[data-merge-submit]').disabled).toBe(false)
    })
})
