// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import RisuBardSaveSlotsDialog from './RisuBardSaveSlotsDialog.svelte'
import type { MemorySaveSlotSummary } from 'src/ts/risubard/memorySaveSlots'

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

    function render(onLoad = vi.fn(async () => undefined), saveProps: {
        mode?: 'save' | 'load'
        onSave?: (saveId?: string) => Promise<MemorySaveSlotSummary>
    } = {}) {
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
                ...saveProps,
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
        expect(document.body.querySelector('[data-save-file-new]')).toBeNull()
    })

    test.each(['save', 'load'] as const)('switches both ways from %s without losing the selected preview or writing data', async (initialMode) => {
        const onSave = vi.fn(async () => ({
            saveId: 'save-1', sourceChatId: 'chat-1', sourceChatName: '성문 앞',
            createdAt: '2026-08-26T08:00:00.000Z', turnCount: 8,
        }))
        const onLoad = render(undefined, { mode: initialMode, onSave })
        await vi.waitFor(() => expect(document.body.textContent).toContain('성문이 열렸다.'))
        const switcher = document.body.querySelector('[data-save-mode-switcher]')
        expect(switcher).not.toBeNull()
        const dialog = document.body.querySelector('[role="dialog"]')!
        const title = document.getElementById(dialog.getAttribute('aria-labelledby')!)!
        expect(title).not.toBeNull()
        expect(switcher!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING)
            .not.toBe(0)
        expect(title.contains(switcher)).toBe(false)

        const otherMode = initialMode === 'save' ? 'load' : 'save'
        for (const nextMode of [otherMode, initialMode]) {
            document.body.querySelector<HTMLButtonElement>(`[data-save-mode="${nextMode}"]`)!.click()
            await vi.waitFor(() => expect(title.textContent).toBe(
                nextMode === 'save' ? '채팅 저장하기' : '채팅 불러오기'
            ))
            for (const mode of ['save', 'load']) {
                expect(document.body.querySelector(`[data-save-mode="${mode}"]`)
                    ?.getAttribute('aria-pressed')).toBe(String(mode === nextMode))
            }
            expect(document.body.querySelector(nextMode === 'save'
                ? '[data-save-file-overwrite]' : '[data-save-file-load]')).not.toBeNull()
            expect(document.body.querySelector('.save-slot__select[aria-pressed="true"]')
                ?.textContent).toContain('성문 앞')
            expect(document.body.querySelector('[data-save-file-preview]')
                ?.textContent).toContain('성문이 열렸다.')
        }
        expect(onSave).not.toHaveBeenCalled()
        expect(onLoad).not.toHaveBeenCalled()
        expect(mocks.listMemorySaveSlots).toHaveBeenCalledOnce()
        expect(mocks.previewMemorySaveSlot).toHaveBeenCalledOnce()
    })

    test('disables save mode when the caller cannot save', async () => {
        render()
        await vi.waitFor(() => expect(document.body.querySelector('[data-save-mode="save"]')).not.toBeNull())
        expect(document.body.querySelector<HTMLButtonElement>('[data-save-mode="save"]')!.disabled).toBe(true)
        expect(document.body.querySelector<HTMLButtonElement>('[data-save-mode="load"]')!.disabled).toBe(false)
    })

    test('opens save mode without saving and creates a slot from an empty list', async () => {
        mocks.listMemorySaveSlots.mockResolvedValue([])
        const onSave = vi.fn(async () => ({
            saveId: 'new-save', sourceChatId: 'chat-1', sourceChatName: '새 저장',
            createdAt: '2026-08-26T08:00:00.000Z', turnCount: 8,
        }))
        render(undefined, { mode: 'save', onSave })
        await vi.waitFor(() => expect(document.body.textContent).toContain('아직 저장된 채팅이 없습니다.'))
        expect(onSave).not.toHaveBeenCalled()
        const button = document.body.querySelector<HTMLButtonElement>('[data-save-file-new]')
        expect(button).not.toBeNull()
        button!.click()
        await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith(undefined))
        await vi.waitFor(() => expect(document.body.textContent).toContain('새 저장'))
        expect(document.body.querySelectorAll('.save-slot')).toHaveLength(1)
        expect(mocks.alertConfirm).not.toHaveBeenCalled()
    })

    test('confirms overwrite, keeps one slot, and refreshes its preview', async () => {
        const onSave = vi.fn(async () => ({
            saveId: 'save-1', sourceChatId: 'chat-1', sourceChatName: '성문 앞',
            createdAt: '2026-08-26T08:00:00.000Z', turnCount: 8,
        }))
        render(undefined, { mode: 'save', onSave })
        await vi.waitFor(() => expect(document.body.textContent).toContain('성문이 열렸다.'))
        const overwrite = document.body.querySelector<HTMLButtonElement>('[aria-label="성문 앞 덮어쓰기"]')
        expect(overwrite).not.toBeNull()
        expect(document.body.querySelector('[data-save-file-load]')).toBeNull()
        mocks.alertConfirm.mockResolvedValueOnce(false)
        overwrite!.click()
        await vi.waitFor(() => expect(mocks.alertConfirm).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(overwrite!.disabled).toBe(false))
        expect(onSave).not.toHaveBeenCalled()
        mocks.previewMemorySaveSlot.mockResolvedValue([{ role: 'char', data: '새로운 장면' }])
        overwrite!.click()
        await vi.waitFor(() => expect(onSave).toHaveBeenCalledWith('save-1'))
        await vi.waitFor(() => expect(document.body.textContent).toContain('새로운 장면'))
        expect(document.body.querySelectorAll('.save-slot')).toHaveLength(1)
        expect(document.body.textContent).toContain('[턴 8]')
    })

    test('blocks duplicate saves and preserves the list on save failure', async () => {
        let rejectSave!: (reason: Error) => void
        const onSave = vi.fn(() => new Promise<MemorySaveSlotSummary>((_resolve, reject) => {
            rejectSave = reject
        }))
        render(undefined, { mode: 'save', onSave })
        await vi.waitFor(() => expect(document.body.textContent).toContain('성문 앞'))
        const button = document.body.querySelector<HTMLButtonElement>('[data-save-file-new]')
        expect(button).not.toBeNull()
        button!.click()
        button!.click()
        await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce())
        for (const selector of ['[data-save-file-new]', '[data-save-file-overwrite]', '[data-save-file-rename]', '[data-save-file-delete]', '[data-save-mode="save"]', '[data-save-mode="load"]']) {
            expect(document.body.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(true)
        }
        rejectSave(new Error('저장 실패 테스트'))
        await vi.waitFor(() => expect(document.body.textContent).toContain('저장 실패 테스트'))
        expect(document.body.querySelectorAll('.save-slot')).toHaveLength(1)
        expect(document.body.textContent).toContain('[턴 7]')
        expect(button!.disabled).toBe(false)
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
