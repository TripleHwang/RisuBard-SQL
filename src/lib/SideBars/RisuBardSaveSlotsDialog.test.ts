// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import RisuBardSaveSlotsDialog from './RisuBardSaveSlotsDialog.svelte'

const mocks = vi.hoisted(() => ({
    listMemorySaveSlots: vi.fn(),
    previewMemorySaveSlot: vi.fn(),
    renameMemorySaveSlot: vi.fn(),
    deleteMemorySaveSlot: vi.fn(),
    alertConfirm: vi.fn(),
    createAuth: vi.fn(async () => 'auth'),
}))

vi.mock('src/ts/risubard/memorySaveSlots', () => ({
    listMemorySaveSlots: mocks.listMemorySaveSlots,
    previewMemorySaveSlot: mocks.previewMemorySaveSlot,
    renameMemorySaveSlot: mocks.renameMemorySaveSlot,
    deleteMemorySaveSlot: mocks.deleteMemorySaveSlot,
    shouldConfirmMemorySaveLoad: (currentLatestMessageId: string, slots: Array<{ latestMessageId?: string }>) =>
        currentLatestMessageId !== slots[0]?.latestMessageId,
}))
vi.mock('src/ts/alert', () => ({
    alertConfirm: mocks.alertConfirm,
    alertInput: vi.fn(),
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: mocks.createAuth },
    downloadFile: vi.fn(),
    saveAsset: vi.fn(),
}))

let mounted: ReturnType<typeof mount> | undefined

describe('RisuBardSaveSlotsDialog', () => {
    beforeEach(() => {
        localStorage.clear()
        mocks.listMemorySaveSlots.mockReset().mockResolvedValue([{
            saveId: 'save-1', sourceChatId: 'chat-1',
            sourceChatName: '성문 앞',
            createdAt: '2026-08-14T08:00:00.000Z', turnCount: 7,
            latestMessageId: 'assistant-1',
            latestEvent: {
                title: '성문이 열렸다',
                excerpt: '경비병이 일행의 통행을 허락했다.',
            },
        }])
        mocks.previewMemorySaveSlot.mockReset().mockResolvedValue([
            { role: 'user', data: '문을 연다.' },
            { role: 'char', data: '성문이 열렸다.' },
        ])
        mocks.alertConfirm.mockReset().mockResolvedValue(true)
    })
    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
    })

    function render(onLoad = vi.fn(async () => undefined)) {
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardSaveSlotsDialog, {
            target,
            props: {
                open: true,
                characterId: 'character',
                currentChatId: 'chat-1',
                currentLatestMessageId: 'unsaved-message',
                onOpenChange: vi.fn(),
                onLoad,
            },
        })
        return onLoad
    }

    test('shows the filename, turn badge, and recent chat preview', async () => {
        render()

        await vi.waitFor(() => expect(document.body.textContent)
            .toContain('성문 앞'))
        expect(document.body.textContent).toContain('2026')
        expect(document.body.textContent).toContain('[턴 7]')
        expect(document.body.textContent).not.toContain('7턴')
        expect(document.body.textContent).toContain("'성문 앞'의 최근 대화")
        await vi.waitFor(() => expect(document.body.textContent)
            .toContain('성문이 열렸다.'))
        expect(document.body.querySelector('[data-save-file-load]')
            ?.className).toContain('save-slot__load')
    })

    test('adjusts the file and preview distribution from the separator', async () => {
        render()
        await vi.waitFor(() => expect(document.body.querySelector(
            '[data-preview-resize-handle]'
        )).not.toBeNull())
        const separator = document.body.querySelector<HTMLElement>(
            '[data-preview-resize-handle]'
        )!

        expect(separator.getAttribute('aria-valuenow')).toBe('45')
        separator.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'ArrowUp', bubbles: true,
        }))

        await vi.waitFor(() => expect(
            separator.getAttribute('aria-valuenow')
        ).toBe('50'))
    })

    test('loads the selected immutable slot', async () => {
        const onLoad = render()
        await vi.waitFor(() => expect(document.body.querySelector(
            '[aria-label="성문 앞 불러오기"]'
        )).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>(
            '[aria-label="성문 앞 불러오기"]'
        )!.click()

        await vi.waitFor(() => expect(mocks.alertConfirm).toHaveBeenCalledWith(
            '저장하지 않은 채팅은 사라집니다. 불러올까요?'
        ))
        await vi.waitFor(() => expect(onLoad).toHaveBeenCalledWith('save-1'))
    })

    test('skips confirmation when the newest save matches the current story', async () => {
        const target = document.body.appendChild(document.createElement('div'))
        const onLoad = vi.fn(async () => undefined)
        mounted = mount(RisuBardSaveSlotsDialog, {
            target,
            props: {
                open: true,
                characterId: 'character',
                currentChatId: 'chat-1',
                currentLatestMessageId: 'assistant-1',
                onOpenChange: vi.fn(),
                onLoad,
            },
        })
        await vi.waitFor(() => expect(document.body.querySelector(
            '[aria-label="성문 앞 불러오기"]'
        )).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>(
            '[aria-label="성문 앞 불러오기"]'
        )!.click()

        await vi.waitFor(() => expect(onLoad).toHaveBeenCalledWith('save-1'))
        expect(mocks.alertConfirm).not.toHaveBeenCalled()
    })
})
