// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import RisuBardSaveSlotsDialog from './RisuBardSaveSlotsDialog.svelte'

const mocks = vi.hoisted(() => ({
    listMemorySaveSlots: vi.fn(),
    previewMemorySaveSlot: vi.fn(),
    createAuth: vi.fn(async () => 'auth'),
}))

vi.mock('src/ts/risubard/memorySaveSlots', () => ({
    listMemorySaveSlots: mocks.listMemorySaveSlots,
    previewMemorySaveSlot: mocks.previewMemorySaveSlot,
    deleteMemorySaveSlot: vi.fn(),
    renameMemorySaveSlot: vi.fn(),
}))
vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(),
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
        mocks.listMemorySaveSlots.mockReset().mockResolvedValue([{
            saveId: 'save-1', sourceChatId: 'chat-1',
            sourceChatName: '성문 앞',
            createdAt: '2026-08-14T08:00:00.000Z', turnCount: 7,
        }])
        mocks.previewMemorySaveSlot.mockReset().mockResolvedValue([{
            role: 'char',
            data: '경비병이 일행의 통행을 허락했다.',
        }])
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
                onOpenChange: vi.fn(),
                onLoad,
            },
        })
        return onLoad
    }

    test('shows actual save time, turn count, and recent chat preview', async () => {
        render()

        await vi.waitFor(() => expect(document.body.textContent)
            .toContain('성문 앞'))
        expect(document.body.textContent).toContain('2026')
        expect(document.body.textContent).toContain('7턴')
        await vi.waitFor(() => expect(document.body.textContent)
            .toContain('경비병이 일행의 통행을 허락했다.')
        )
    })

    test('loads the selected immutable slot', async () => {
        const onLoad = render()
        await vi.waitFor(() => expect(document.body.querySelector(
            '[aria-label="성문 앞 불러오기"]'
        )).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>(
            '[aria-label="성문 앞 불러오기"]'
        )!.click()

        await vi.waitFor(() => expect(onLoad).toHaveBeenCalledWith('save-1'))
    })
})
