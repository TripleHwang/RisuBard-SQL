import { describe, expect, test } from 'vitest'
import type { Database, folder } from './storage/database.svelte'
import {
    applyCharacterVaultClones,
    createCharacterVaultFolder,
    createCharacterVaultClones,
    deleteCharacterVaultFolder,
    getCharacterVaultQuickAccess,
    moveCharactersToVaultFolder,
    pinCharacterVaultQuickAccess,
    setCharacterVaultQuickAccess,
    sortCharacterVaultCharacters,
    trashCharacterVaultCharacters,
    toggleCharacterVaultQuickAccess,
} from './characterVault'

function makeDb(): Database {
    return {
        characters: [
            { chaId: 'a', name: 'Alice' },
            { chaId: 'b', name: 'Bryn' },
            { chaId: 'c', name: 'Cato' },
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

function getFolder(db: Database, id: string): folder {
    const result = db.characterOrder.find((entry): entry is folder =>
        typeof entry !== 'string' && entry.id === id
    )
    if (!result) throw new Error(`Folder ${id} not found`)
    return result
}

describe('Character Vault state', () => {
    test('uses canonical top-level order as the legacy quick inventory', () => {
        expect(getCharacterVaultQuickAccess(makeDb())).toEqual([
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'c' },
        ])
    })

    test('prunes stale and duplicate explicit quick shortcuts', () => {
        const db = makeDb()
        db.characterVault = {
            quickAccess: [
                { kind: 'character', id: 'a' },
                { kind: 'character', id: 'missing' },
                { kind: 'character', id: 'a' },
                { kind: 'folder', id: 'folder-1' },
            ],
        }

        expect(getCharacterVaultQuickAccess(db)).toEqual([
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
        ])
    })

    test('excludes trashed characters from legacy and explicit quick access', () => {
        const db = makeDb()
        db.characters[0].trashTime = Date.now()
        db.characterVault = {
            quickAccess: [
                { kind: 'character', id: 'a' },
                { kind: 'character', id: 'c' },
            ],
        }

        expect(getCharacterVaultQuickAccess(db)).toEqual([
            { kind: 'character', id: 'c' },
        ])
    })

    test('persists an explicit quick inventory and toggles entries', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [{ kind: 'character', id: 'a' }])
        toggleCharacterVaultQuickAccess(db, { kind: 'folder', id: 'folder-1' })
        toggleCharacterVaultQuickAccess(db, { kind: 'character', id: 'a' })

        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'folder', id: 'folder-1' },
        ])
    })

    test('pins a newly imported character first without duplicate shortcuts', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'a' },
        ])

        pinCharacterVaultQuickAccess(db, 'c')
        pinCharacterVaultQuickAccess(db, 'a')

        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'character', id: 'a' },
            { kind: 'character', id: 'c' },
            { kind: 'folder', id: 'folder-1' },
        ])
    })

    test('moves selected characters into one folder without duplicates', () => {
        const db = makeDb()
        moveCharactersToVaultFolder(db, ['a', 'b'], 'folder-1')

        expect(getFolder(db, 'folder-1').data).toEqual(['b', 'a'])
        expect(db.characterOrder).toEqual([
            expect.objectContaining({ id: 'folder-1' }),
            'c',
        ])
    })

    test('deduplicates damaged legacy membership without dropping its folder', () => {
        const db = makeDb()
        db.characterOrder.splice(1, 0, {
            id: 'legacy-duplicate',
            name: 'Legacy',
            color: 'default',
            data: ['a'],
        })

        moveCharactersToVaultFolder(db, ['a'], 'folder-1')

        expect(getFolder(db, 'folder-1').data).toEqual(['b', 'a'])
        expect(getFolder(db, 'legacy-duplicate').data).toEqual([])
    })

    test('moves selected characters out as unfiled entries', () => {
        const db = makeDb()
        moveCharactersToVaultFolder(db, ['b'], null)

        expect(db.characterOrder).toEqual([
            'a',
            expect.objectContaining({ id: 'folder-1', data: [] }),
            'b',
            'c',
        ])
    })

    test('deleting a folder preserves its characters as unfiled entries', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [
            { kind: 'folder', id: 'folder-1' },
        ])
        deleteCharacterVaultFolder(db, 'folder-1')

        expect(db.characterOrder).toEqual(['a', 'b', 'c'])
        expect(db.characterVault?.quickAccess).toEqual([])
    })

    test('deleting a folder does not duplicate already unfiled characters', () => {
        const db = makeDb()
        getFolder(db, 'folder-1').data.unshift('a')

        deleteCharacterVaultFolder(db, 'folder-1')

        expect(db.characterOrder).toEqual(['a', 'b', 'c'])
    })

    test('creates and preserves an empty named folder', () => {
        const db = makeDb()
        const created = createCharacterVaultFolder(
            db, '  Supporting Cast  ', 'folder-empty'
        )

        expect(created).toEqual({
            id: 'folder-empty',
            name: 'Supporting Cast',
            color: 'default',
            data: [],
        })

        moveCharactersToVaultFolder(db, ['a'], 'folder-1')
        expect(getFolder(db, 'folder-empty').data).toEqual([])
    })

    test('moves selected characters to trash and preserves emptied folders', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
        ])

        expect(trashCharacterVaultCharacters(db, ['a', 'b'], 1234)).toBe(2)
        expect(db.characters.find((character) => character.chaId === 'a')?.trashTime)
            .toBe(1234)
        expect(db.characters.find((character) => character.chaId === 'b')?.trashTime)
            .toBe(1234)
        expect(db.characterOrder).toEqual([
            expect.objectContaining({ id: 'folder-1', data: [] }),
            'c',
        ])
        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'folder', id: 'folder-1' },
        ])
    })

    test.each([
        ['name', 'asc', ['b', 'c', 'a']],
        ['name', 'desc', ['a', 'c', 'b']],
        ['lastInteraction', 'asc', ['b', 'a', 'c']],
        ['lastInteraction', 'desc', ['c', 'a', 'b']],
        ['creationDate', 'asc', ['c', 'a', 'b']],
        ['creationDate', 'desc', ['b', 'a', 'c']],
    ] as const)('sorts characters by %s %s', (sortBy, direction, expected) => {
        const characters = [
            { chaId: 'a', name: 'Zulu', lastInteraction: 20, creation_date: 10 },
            { chaId: 'b', name: 'Alpha', lastInteraction: 10, creation_date: 30 },
            { chaId: 'c', name: 'Middle', lastInteraction: 30, creation_date: 5 },
        ]

        expect(sortCharacterVaultCharacters(characters, sortBy, direction)
            .map((character) => character.chaId)).toEqual(expected)
    })

    test('plans chat-inclusive clones with unique character and chat IDs', () => {
        const db = makeDb()
        db.characters[0] = {
            ...db.characters[0],
            chats: [{
                id: 'chat-a', name: 'Long chat', note: '', localLore: [],
                message: [{ role: 'char', data: 'hello', chatId: 'message-1' }],
            }],
            chatFolders: [],
            chatPage: 0,
        } as typeof db.characters[number]
        db.characters.push({ chaId: 'taken', name: 'Alice-2' } as typeof db.characters[number])
        const ids = ['clone-a', 'chat-copy']

        const [plan] = createCharacterVaultClones(db, ['a'], {
            withChats: true,
            createId: () => ids.shift()!,
            now: 500,
        })

        expect(plan.clone).toMatchObject({
            chaId: 'clone-a', name: 'Alice-3', creation_date: 500,
            chats: [{ id: 'chat-copy', name: 'Long chat' }],
        })
        expect(plan.clone.chats[0].message[0].chatId).toBe('message-1')
        expect(plan.chatForks).toEqual([{
            sourceChatId: 'chat-a', destinationChatId: 'chat-copy',
        }])
        expect(db.characters.map((character) => character.chaId))
            .not.toContain('clone-a')
    })

    test('creates one empty chat when cloning without chats', () => {
        const db = makeDb()
        db.characters[0] = {
            ...db.characters[0],
            chats: [{
                id: 'chat-a', name: 'Long chat', note: 'private', localLore: [],
                message: [{ role: 'char', data: 'hello', chatId: 'message-1' }],
            }],
            chatFolders: [{ id: 'folder', folded: false }],
            chatPage: 0,
        } as typeof db.characters[number]
        const ids = ['clone-a', 'empty-chat']

        const [plan] = createCharacterVaultClones(db, ['a'], {
            withChats: false,
            createId: () => ids.shift()!,
            now: 500,
        })

        expect(plan.clone.chats).toEqual([expect.objectContaining({
            id: 'empty-chat', name: 'Chat 1', message: [], localLore: [],
        })])
        expect(plan.clone.chatFolders).toEqual([])
        expect(plan.clone.chatPage).toBe(0)
        expect(plan.chatForks).toEqual([])
    })

    test('inserts clones beside their sources in the same vault location', () => {
        const db = makeDb()
        const ids = ['clone-a', 'empty-a', 'clone-b', 'empty-b']
        const plans = createCharacterVaultClones(db, ['a', 'b'], {
            withChats: false,
            createId: () => ids.shift()!,
            now: 500,
        })

        applyCharacterVaultClones(db, plans)

        expect(db.characters.slice(-2).map((character) => character.chaId))
            .toEqual(['clone-a', 'clone-b'])
        expect(db.characterOrder).toEqual([
            'a', 'clone-a',
            expect.objectContaining({ id: 'folder-1', data: ['b', 'clone-b'] }),
            'c',
        ])
    })
})
