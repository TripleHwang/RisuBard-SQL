// @vitest-environment happy-dom
import { mount, tick, unmount } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RisuBardWikiEditor from './RisuBardWikiEditor.svelte'

const mocks = vi.hoisted(() => ({
    saveManualWikiDocument: vi.fn(),
    trashWikiDocument: vi.fn(),
    retractWikiEvent: vi.fn(),
    revealWikiDocument: vi.fn(),
    setWikiDocumentContextMode: vi.fn(),
    createAuth: vi.fn(async () => 'token'),
    requestImmediateSave: vi.fn(async () => undefined),
    alertConfirmMulti: vi.fn(async () => 0),
    db: { characters: [] as Array<Record<string, any>> },
}))

vi.mock('src/ts/risubard/memoryWiki', async (importOriginal) => ({
    ...await importOriginal<typeof import('src/ts/risubard/memoryWiki')>(),
    saveManualWikiDocument: mocks.saveManualWikiDocument,
    trashWikiDocument: mocks.trashWikiDocument,
    retractWikiEvent: mocks.retractWikiEvent,
    revealWikiDocument: mocks.revealWikiDocument,
    setWikiDocumentContextMode: mocks.setWikiDocumentContextMode,
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: { createAuth: mocks.createAuth },
    requestImmediateSave: mocks.requestImmediateSave,
}))
vi.mock('src/ts/stores.svelte', () => ({
    DBState: { get db() { return mocks.db } },
}))
vi.mock('src/ts/alert', () => ({
    alertConfirmMulti: mocks.alertConfirmMulti,
}))

const documents = [{
    id: 'character.lavian',
    type: 'character' as const,
    status: 'active' as const,
    title: '라비안',
    relativePath: 'characters/라비안.md',
    sourceMessageIds: [],
    updated: '2026-08-08T00:00:00.000Z',
    content: '# 라비안\n\n기사.',
    links: [],
    contextMode: 'auto' as const,
    contentHash: 'hash-lavian',
}, {
    id: 'event.turn',
    type: 'event' as const,
    status: 'active' as const,
    title: '전투',
    relativePath: 'events/turn-1.md',
    sourceMessageIds: ['assistant-1'],
    updated: '2026-08-08T00:01:00.000Z',
    content: '# 전투\n\n승리했다.',
    links: [],
    contextMode: 'auto' as const,
    contentHash: 'hash-event',
}]

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.clearAllMocks()
    vi.unstubAllGlobals()
})

describe('RisuBardWikiEditor', () => {
    it('copies a saved wiki document into the character lorebook without AI', async () => {
        const character = { chaId: 'character', globalLore: [] }
        mocks.db.characters = [character]
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardWikiEditor, {
            target,
            props: { characterId: 'character', chatId: 'chat', documents },
        })
        await tick()

        const copy = [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === '로어북에 복사')!
        copy.click()

        await vi.waitFor(() => expect(character.globalLore).toHaveLength(1))
        expect(character.globalLore[0]).toEqual(expect.objectContaining({
            comment: '라비안',
            content: '# 라비안\n\n기사.',
            enabled: false,
            alwaysActive: false,
            key: '',
            secondkey: '',
        }))
        expect(mocks.alertConfirmMulti).not.toHaveBeenCalled()
        expect(mocks.requestImmediateSave).toHaveBeenCalledWith({
            forceFullWrite: true,
            rejectOnFailure: true,
        })
    })

    it('asks whether to overwrite or create a suffixed lorebook entry', async () => {
        const existing = {
            id: 'existing', comment: '라비안', content: 'old', enabled: true,
            key: 'old-key', secondkey: '', insertorder: 100, mode: 'normal',
            alwaysActive: true, selective: false,
        }
        const character = { chaId: 'character', globalLore: [existing] }
        mocks.db.characters = [character]
        mocks.alertConfirmMulti.mockResolvedValueOnce(0)
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardWikiEditor, {
            target,
            props: { characterId: 'character', chatId: 'chat', documents },
        })
        await tick()

        const copy = [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === '로어북에 복사')!
        copy.click()

        await vi.waitFor(() => expect(character.globalLore[0].content)
            .toBe('# 라비안\n\n기사.'))
        expect(mocks.alertConfirmMulti).toHaveBeenCalledWith(
            expect.stringContaining('같은 이름'),
            [expect.objectContaining({ label: '덮어쓰기' }),
                expect.objectContaining({ label: '새 항목으로 복사' })],
            expect.any(String)
        )
        expect(character.globalLore).toHaveLength(1)
        expect(character.globalLore[0]).toEqual(expect.objectContaining({
            id: 'existing', enabled: false, alwaysActive: false, key: '',
        }))
    })

    it('renders a folder tree and keeps event evidence read-only', async () => {
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardWikiEditor, {
            target,
            props: { characterId: 'character', chatId: 'chat', documents },
        })
        await tick()

        expect(document.body.textContent).toContain('characters')
        expect(document.body.textContent).toContain('events')
        const eventButton = [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.includes('전투'))!
        eventButton.click()
        await tick()
        expect(document.querySelector<HTMLTextAreaElement>('[aria-label="Markdown"]')?.readOnly)
            .toBe(true)
        expect(document.body.textContent).toContain('읽기 전용')
    })

    it('permanently deletes an active event after explicit confirmation', async () => {
        mocks.retractWikiEvent.mockResolvedValue({
            ...documents[1], status: 'retracted', contentHash: 'hash-retracted',
        })
        const confirm = vi.fn(() => true)
        vi.stubGlobal('confirm', confirm)
        const onChanged = vi.fn()
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardWikiEditor, {
            target,
            props: {
                characterId: 'character', chatId: 'chat', documents, onChanged,
            },
        })
        await tick()

        const eventButton = [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.includes('전투'))!
        eventButton.click()
        await tick()
        const retractButton = [...document.querySelectorAll('button')]
            .find((button) => button.textContent?.trim() === '사건 영구 삭제')!
        retractButton.click()

        await vi.waitFor(() => {
            expect(mocks.retractWikiEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    characterId: 'character',
                    chatId: 'chat',
                    documentId: 'event.turn',
                    expectedContentHash: 'hash-event',
                })
            )
            expect(onChanged).toHaveBeenCalled()
        })
        expect(confirm).toHaveBeenCalledWith(expect.stringContaining(
            '복구할 수 없습니다'
        ))
    })

    it('creates, edits, and trashes canonical pages without calling AI', async () => {
        mocks.saveManualWikiDocument.mockResolvedValue(documents[0])
        mocks.trashWikiDocument.mockResolvedValue({
            id: 'character.lavian',
            trashed: true,
        })
        vi.stubGlobal('confirm', vi.fn(() => true))
        const onChanged = vi.fn()
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardWikiEditor, {
            target,
            props: {
                characterId: 'character', chatId: 'chat', documents, onChanged,
            },
        })
        await tick()

        const button = (label: string) => [...document.querySelectorAll('button')]
            .find((item) => item.textContent?.trim() === label)!
        button('새 문서').click()
        await tick()
        const type = document.querySelector<HTMLSelectElement>('[aria-label="항목 유형"]')!
        type.selectedIndex = [...type.options]
            .findIndex((option) => option.value === 'location')
        type.dispatchEvent(new Event('input', { bubbles: true }))
        type.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
        const title = document.querySelector<HTMLInputElement>('[aria-label="항목 이름"]')!
        title.value = '케사리아'
        title.dispatchEvent(new Event('input', { bubbles: true }))
        const markdown = document.querySelector<HTMLTextAreaElement>('[aria-label="Markdown"]')!
        markdown.value = '# 케사리아\n\n도시.'
        markdown.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        button('저장').click()
        await vi.waitFor(() => expect(mocks.saveManualWikiDocument).toHaveBeenCalled())

        expect(mocks.saveManualWikiDocument).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'character',
                title: '케사리아',
                markdown: '# 케사리아\n\n도시.',
            })
        )
        const characterButton = [...document.querySelectorAll('button')]
            .find((item) => item.textContent?.includes('라비안'))!
        characterButton.click()
        await tick()
        await vi.waitFor(() => expect(
            (button('삭제') as HTMLButtonElement).disabled
        ).toBe(false))
        button('삭제').click()
        await vi.waitFor(() => expect(mocks.trashWikiDocument).toHaveBeenCalled())
        expect(mocks.trashWikiDocument).toHaveBeenCalledWith(
            expect.objectContaining({ documentId: 'character.lavian' })
        )
        expect(onChanged).toHaveBeenCalled()
    })

    it('changes context policy and reveals either file from its context menu', async () => {
        mocks.revealWikiDocument.mockResolvedValue({ ok: true })
        const target = document.body.appendChild(document.createElement('div'))
        mounted = mount(RisuBardWikiEditor, {
            target,
            props: {
                characterId: 'character',
                chatId: 'chat',
                documents,
            },
        })
        await tick()

        const characterButton = [...document.querySelectorAll('button')]
            .find((item) => item.textContent?.includes('라비안'))!
        characterButton.dispatchEvent(new MouseEvent('contextmenu', {
            bubbles: true,
            clientX: 120,
            clientY: 80,
        }))
        await tick()
        expect(document.querySelector('[data-wiki-send-to-workbench]')).toBeNull()

        mocks.setWikiDocumentContextMode.mockResolvedValue({
            ...documents[0], contextMode: 'always', contentHash: 'hash-next',
        })
        characterButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
        await tick()
        document.querySelector<HTMLButtonElement>('[data-wiki-context-always]')?.click()
        await vi.waitFor(() => expect(
            mocks.setWikiDocumentContextMode
        ).toHaveBeenCalledWith(expect.objectContaining({
            documentId: 'character.lavian',
            contextMode: 'always',
            expectedContentHash: 'hash-lavian',
        })))

        characterButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
        await tick()
        document.querySelector<HTMLButtonElement>('[data-wiki-reveal-file]')?.click()
        await vi.waitFor(() => expect(mocks.revealWikiDocument).toHaveBeenCalledWith(
            expect.objectContaining({ documentId: 'character.lavian' })
        ))

        const eventButton = [...document.querySelectorAll('button')]
            .find((item) => item.textContent?.includes('전투'))!
        eventButton.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
        await tick()
        expect(document.querySelector('[data-wiki-send-to-workbench]')).toBeNull()
        expect(document.querySelector('[data-wiki-reveal-file]')).not.toBeNull()
    })
})
