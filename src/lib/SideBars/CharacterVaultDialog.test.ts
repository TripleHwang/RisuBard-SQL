// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { Database } from 'src/ts/storage/database.svelte'
import CharacterVaultDialog from './CharacterVaultDialog.svelte'

const mocks = vi.hoisted(() => ({
    db: {} as Database,
    requestImmediateSave: vi.fn(async () => undefined),
    selectSingleFile: vi.fn(),
    saveAsset: vi.fn(async () => 'vault-cover'),
    getFileSrc: vi.fn(async () => 'vault-cover-src'),
    alertConfirm: vi.fn(async () => true),
    alertInput: vi.fn(async () => ''),
    selectedCharID: { set: vi.fn() },
    requiresFullEncoderReload: { state: false },
    forkMemoryWiki: vi.fn(async (input: { destinationChatId: string }) => ({
        mode: 'copy' as const,
        sourceExists: true,
        destinationChatId: input.destinationChatId,
        warnings: [],
        forkToken: `token-${input.destinationChatId}`,
    })),
    completeMemoryWikiFork: vi.fn(async (input: { action: 'finalize' | 'discard' }) => ({
        action: input.action,
        completed: true as const,
    })),
    createAuth: vi.fn(async () => 'auth'),
}))

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { get db() { return mocks.db } },
    selectedCharID: mocks.selectedCharID,
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    requestImmediateSave: mocks.requestImmediateSave,
    saveAsset: mocks.saveAsset,
    getFileSrc: mocks.getFileSrc,
    requiresFullEncoderReload: mocks.requiresFullEncoderReload,
    forageStorage: { createAuth: mocks.createAuth },
}))
vi.mock('src/ts/risubard/memoryWikiFork', () => ({
    forkMemoryWiki: mocks.forkMemoryWiki,
    completeMemoryWikiFork: mocks.completeMemoryWikiFork,
}))
vi.mock('src/ts/util', () => ({
    selectSingleFile: mocks.selectSingleFile,
}))
vi.mock('src/ts/characters', () => ({
    getCharImage: vi.fn(async (value: string) => value || '/none.webp'),
}))
vi.mock('src/ts/alert', () => ({
    alertConfirm: mocks.alertConfirm,
    alertInput: mocks.alertInput,
}))

let mounted: ReturnType<typeof mount> | undefined

function makeDb(): Database {
    return {
        characters: [
            { chaId: 'a', name: 'Alice', image: 'alice.webp', lastInteraction: 300, creation_date: 100 },
            { chaId: 'b', name: 'Bryn', image: 'bryn.webp', lastInteraction: 100, creation_date: 300 },
            { chaId: 'c', name: 'Cato', image: '', lastInteraction: 200, creation_date: 200 },
        ],
        characterOrder: [
            'a',
            {
                id: 'folder-1',
                name: 'Cast',
                color: 'blue',
                data: ['b'],
            },
            'c',
        ],
    } as Database
}

async function render(expectedImages = 3) {
    const target = document.body.appendChild(document.createElement('div'))
    mounted = mount(CharacterVaultDialog, {
        target,
        props: {
            open: true,
            onOpenChange: vi.fn(),
            onSelectCharacter: vi.fn(),
        },
    })
    await tick()
    await vi.waitFor(() => expect(document.body.textContent)
        .toContain('Character Vault'))
    await vi.waitFor(() => expect(
        document.body.querySelectorAll('.portrait img')
    ).toHaveLength(expectedImages))
}

function click(label: string) {
    const button = document.body.querySelector<HTMLButtonElement>(
        `[aria-label="${label}"]`
    )
    if (!button) throw new Error(`Missing button: ${label}`)
    button.click()
}

describe('CharacterVaultDialog', () => {
    beforeEach(() => {
        mocks.db = makeDb()
        mocks.requestImmediateSave.mockClear()
        mocks.alertConfirm.mockClear().mockResolvedValue(true)
        mocks.alertInput.mockClear().mockResolvedValue('')
        mocks.selectedCharID.set.mockClear()
        mocks.requiresFullEncoderReload.state = false
        mocks.forkMemoryWiki.mockClear()
        mocks.completeMemoryWikiFork.mockClear()
        mocks.createAuth.mockClear()
    })

    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
    })

    test('filters the full vault by character name', async () => {
        await render()
        const search = document.body.querySelector<HTMLInputElement>(
            '[aria-label="캐릭터 검색"]'
        )!
        search.value = 'Alice'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()

        expect(document.body.textContent).toContain('Alice')
        expect(document.body.textContent).not.toContain('Cato')
    })

    test('duplicates selected characters with chats and their BardWiki workspaces', async () => {
        Object.assign(mocks.db.characters[0], {
            chats: [{
                id: 'chat-a', name: 'Long chat', note: '', localLore: [],
                message: [{ role: 'char', data: 'hello', chatId: 'message-1' }],
            }],
            chatFolders: [],
            chatPage: 0,
        })
        await render()
        click('Alice 선택')
        await tick()

        click('선택 캐릭터 챗 포함 복제')

        await vi.waitFor(() => expect(mocks.forkMemoryWiki).toHaveBeenCalledOnce())
        await vi.waitFor(() => expect(mocks.db.characters).toHaveLength(4))
        const clone = mocks.db.characters.find((character) =>
            character.chaId !== 'a' && character.name === 'Alice-2'
        )!
        expect(clone).toBeDefined()
        expect(clone.chats[0].id).not.toBe('chat-a')
        expect(clone.chats[0].message[0].chatId).toBe('message-1')
        expect(mocks.forkMemoryWiki).toHaveBeenCalledWith(expect.objectContaining({
            characterId: 'a',
            destinationCharacterId: clone.chaId,
            sourceChatId: 'chat-a',
            destinationChatId: clone.chats[0].id,
        }))
        await vi.waitFor(() => expect(mocks.completeMemoryWikiFork)
            .toHaveBeenCalledWith(expect.objectContaining({
                characterId: clone.chaId,
                action: 'finalize',
            })))
        expect(mocks.requestImmediateSave).toHaveBeenCalledWith({
            forceFullWrite: true,
            rejectOnFailure: true,
        })
    })

    test('duplicates selected characters without chats or BardWiki calls', async () => {
        Object.assign(mocks.db.characters[0], {
            chats: [{
                id: 'chat-a', name: 'Long chat', note: '', localLore: [],
                message: [{ role: 'char', data: 'hello', chatId: 'message-1' }],
            }],
            chatFolders: [],
            chatPage: 0,
        })
        await render()
        click('Alice 선택')
        await tick()

        click('선택 캐릭터 챗 제외 복제')

        await vi.waitFor(() => expect(mocks.db.characters).toHaveLength(4))
        const clone = mocks.db.characters.find((character) =>
            character.chaId !== 'a' && character.name === 'Alice-2'
        )!
        expect(clone.chats).toEqual([expect.objectContaining({
            name: 'Chat 1', message: [], localLore: [],
        })])
        expect(mocks.forkMemoryWiki).not.toHaveBeenCalled()
        expect(mocks.completeMemoryWikiFork).not.toHaveBeenCalled()
    })

    test('does not expose characters that are in the trash', async () => {
        mocks.db.characters[0].trashTime = Date.now()
        await render(2)

        expect(document.body.textContent).not.toContain('Alice')
        expect(document.body.textContent).toContain('Bryn')
    })

    test('moves a multi-selection into a folder and saves immediately', async () => {
        await render()
        click('Alice 선택')
        click('Cato 선택')
        await tick()
        expect(document.body.textContent).toContain('2명 선택')
        const target = document.body.querySelector<HTMLSelectElement>(
            '[aria-label="선택 캐릭터 이동"]'
        )!
        target.value = 'folder-1'
        target.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
        click('선택 항목 이동')
        await tick()

        const folder = mocks.db.characterOrder.find((entry) =>
            typeof entry !== 'string' && entry.id === 'folder-1'
        )
        expect(typeof folder === 'string' ? [] : folder?.data)
            .toEqual(['b', 'a', 'c'])
        expect(mocks.requestImmediateSave).toHaveBeenCalled()
    })

    test('selects every character in the current filtered scope', async () => {
        await render()
        click('현재 목록 전체 선택')
        await tick()

        expect(document.body.textContent).toContain('3명 선택')
    })

    test('creates an empty folder from the storage rail toolbar', async () => {
        mocks.alertInput.mockResolvedValue('Supporting Cast')
        await render()
        click('새 폴더 만들기')
        await tick()

        const folder = mocks.db.characterOrder.find((entry) =>
            typeof entry !== 'string' && entry.name === 'Supporting Cast'
        )
        expect(typeof folder === 'string' ? undefined : folder?.data).toEqual([])
        expect(mocks.requestImmediateSave).toHaveBeenCalled()
    })

    test('deletes the active folder from the storage rail toolbar', async () => {
        await render()
        click('Cast 폴더 열기')
        await tick()
        click('선택한 폴더 삭제')
        await tick()

        expect(mocks.db.characterOrder.some((entry) =>
            typeof entry !== 'string' && entry.id === 'folder-1'
        )).toBe(false)
        expect(mocks.db.characterOrder).toContain('b')
    })

    test('replaces selection-time folder creation with confirmed bulk trash', async () => {
        await render()
        click('Alice 선택')
        click('Cato 선택')
        await tick()

        expect(document.body.querySelector('[aria-label="새 폴더 이름"]')).toBeNull()
        expect(document.body.querySelector('[aria-label="선택 항목으로 폴더 생성"]')).toBeNull()
        click('선택 캐릭터 삭제')
        await tick()

        expect(mocks.db.characters.find((character) => character.chaId === 'a')?.trashTime)
            .toEqual(expect.any(Number))
        expect(mocks.db.characters.find((character) => character.chaId === 'c')?.trashTime)
            .toEqual(expect.any(Number))
        expect(mocks.selectedCharID.set).toHaveBeenCalledWith(-1)
        expect(mocks.requiresFullEncoderReload.state).toBe(true)
        expect(mocks.requestImmediateSave).toHaveBeenCalled()
    })

    test('sorts cards by criterion and toggles ascending or descending order', async () => {
        await render()
        const names = () => Array.from(document.body.querySelectorAll(
            '.character-caption strong'
        )).map((element) => element.textContent)
        expect(names()).toEqual(['Alice', 'Bryn', 'Cato'])

        const sort = document.body.querySelector<HTMLSelectElement>(
            '[aria-label="캐릭터 정렬 기준"]'
        )!
        sort.value = 'lastInteraction'
        sort.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
        expect(names()).toEqual(['Bryn', 'Cato', 'Alice'])

        click('정렬 방향: 오름차')
        await tick()
        expect(names()).toEqual(['Alice', 'Cato', 'Bryn'])
        expect(document.body.querySelector('[aria-label="정렬 방향: 내림차"]'))
            .not.toBeNull()
    })

    test('adds and removes characters from the quick inventory', async () => {
        await render()
        click('Alice 퀵 인벤토리 전환')
        await tick()

        expect(mocks.db.characterVault?.quickAccess).not.toContainEqual({
            kind: 'character', id: 'a',
        })
        expect(document.body.querySelector('[aria-live="polite"]')?.textContent)
            .toContain('퀵 인벤토리에서 제거됨')
    })

    test('renames and recolors the active folder', async () => {
        await render()
        click('Cast 폴더 열기')
        await tick()
        const name = document.body.querySelector<HTMLInputElement>(
            '[aria-label="폴더 이름"]'
        )!
        name.value = 'Main Cast'
        name.dispatchEvent(new Event('change', { bubbles: true }))
        const color = document.body.querySelector<HTMLInputElement>(
            '[aria-label="폴더 사용자 지정 색상"]'
        )!
        color.value = '#123456'
        color.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()

        const folder = mocks.db.characterOrder.find((entry) =>
            typeof entry !== 'string' && entry.id === 'folder-1'
        )
        expect(typeof folder === 'string' ? '' : folder?.name).toBe('Main Cast')
        expect(typeof folder === 'string' ? '' : folder?.color).toBe('#123456')
        expect(mocks.requestImmediateSave).toHaveBeenCalled()
    })
})
