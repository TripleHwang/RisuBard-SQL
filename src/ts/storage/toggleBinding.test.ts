import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('../stores.svelte', () => {
    const noopStore = { subscribe: () => () => {}, set: () => {}, update: () => {} }
    return {
        DBState: { db: {} },
        selectedCharID: noopStore,
        selIdState: { selId: -1 },
    }
})

vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: () => Promise.resolve(''),
}))

vi.mock('../alert', () => ({
    notifySuccess: () => {},
    alertError: () => {},
}))

vi.mock('../../lang', () => ({
    language: {},
    changeLanguage: () => {},
}))

const {
    applyToggleValues,
    fillMissingPinnedToggleValues,
    getDatabase,
    loadTogglesFromChat,
    pinToggleValuesToChat,
    snapshotCurrentToggleValues,
    setDatabase,
    setDatabaseLite,
    unpinToggleValuesFromChat,
} = await import('./database.svelte')

function makeDb() {
    return {
        customPromptTemplateToggle: 'one=Toggle One\ntwo=Toggle Two=text',
        globalChatVariables: {
            toggle_one: '1',
            toggle_two: '',
            toggle_other_bot: 'foreign',
            unrelated: 'global',
        },
        modules: [],
        enabledModules: [],
        moduleIntergration: '',
    } as any
}

function makeChat() {
    return { message: [], note: '', name: '', localLore: [], modules: [] } as any
}

function makeCharacter(chat: any) {
    return { chats: [chat], chatPage: 0, modules: [] } as any
}

describe('per-chat toggle pinning', () => {
    let db: ReturnType<typeof makeDb>
    let chat: ReturnType<typeof makeChat>
    let character: ReturnType<typeof makeCharacter>

    beforeEach(() => {
        db = makeDb()
        chat = makeChat()
        character = makeCharacter(chat)
    })

    test('copies current toggle values, including empty strings, without copying unrelated globals', () => {
        pinToggleValuesToChat(chat, db, character)

        expect(chat.useLocallySetGlobalVariables).toBe(true)
        expect(chat.GLGlobalVariables).toEqual({ toggle_one: '1', toggle_two: '' })
        expect(chat.GLGlobalVariables).not.toHaveProperty('toggle_other_bot')
        expect(chat.savedToggleValues).toBeUndefined()
    })

    test('snapshots and applies presets against the local map while pinned', () => {
        pinToggleValuesToChat(chat, db, character)
        db.globalChatVariables.toggle_one = 'global-unchanged'

        applyToggleValues({ toggle_one: 'local' }, db, character, chat)

        expect(snapshotCurrentToggleValues(db, character, chat)).toEqual({ toggle_one: 'local', toggle_two: '' })
        expect(db.globalChatVariables.toggle_one).toBe('global-unchanged')
    })

    test('unpinning drops the local map and restores global fallback', () => {
        pinToggleValuesToChat(chat, db, character)
        chat.GLGlobalVariables.toggle_one = 'local'

        unpinToggleValuesFromChat(chat)

        expect(chat.useLocallySetGlobalVariables).toBe(false)
        expect(chat.GLGlobalVariables).toBeUndefined()
        expect(db.globalChatVariables.toggle_one).toBe('1')
    })

    test('migrates the existing saved-toggle binding without mutating global values', () => {
        chat.savedToggleValues = { toggle_one: 'legacy' }

        loadTogglesFromChat(chat, db, character)

        expect(chat.useLocallySetGlobalVariables).toBe(true)
        expect(chat.GLGlobalVariables).toEqual({ toggle_one: 'legacy' })
        expect(chat.savedToggleValues).toBeUndefined()
        expect(db.globalChatVariables.toggle_one).toBe('1')
    })

    test('fills a partial pinned map from global values so UI and generation agree', () => {
        chat.useLocallySetGlobalVariables = true
        chat.GLGlobalVariables = { toggle_one: 'local' }

        fillMissingPinnedToggleValues(chat, ['toggle_one', 'toggle_two'], db)

        expect(chat.GLGlobalVariables).toEqual({ toggle_one: 'local', toggle_two: '' })
    })

    test('migrates the initially selected legacy chat during database hydration', () => {
        const initial = makeChat()
        initial.savedToggleValues = { toggle_one: 'legacy' }

        setDatabase({
            characters: [{ ...makeCharacter(initial), risuBardWikiGuide: '' }],
            formatingOrder: ['main'],
            loreBook: [],
            personas: [{ name: 'User', icon: '', personaPrompt: '' }],
            selectedPersona: 0,
            username: 'User',
            userIcon: '',
            userNote: '',
        } as any)

        const hydrated = getDatabase().characters[0].chats[0]
        expect(hydrated.useLocallySetGlobalVariables).toBe(true)
        expect(hydrated.GLGlobalVariables).toEqual({ toggle_one: 'legacy' })
        expect(hydrated.savedToggleValues).toBeUndefined()
    })

    test('preserves deferred persona, lorebook, and organizer selections until full hydration', () => {
        const organizers = {
            promptPresets: {
                folders: [{ id: 'preset-folder', name: 'Presets', createdAt: 1 }],
                folderByItemId: { 'preset-two': 'preset-folder' },
                itemOrder: ['preset-two'],
            },
            modules: {
                folders: [{ id: 'module-folder', name: 'Modules', createdAt: 1 }],
                folderByItemId: { 'module-two': 'module-folder' },
                itemOrder: ['module-two'],
            },
            plugins: {
                folders: [{ id: 'plugin-folder', name: 'Plugins', createdAt: 1 }],
                folderByItemId: { 'plugin-two': 'plugin-folder' },
                itemOrder: ['plugin-two'],
            },
        }

        // This is the exact metadata-first order: install the shallow payload
        // without normalizing it, merge the deferred domains, then normalize once.
        setDatabaseLite({
            characters: [], formatingOrder: ['main'], username: 'User', userIcon: '', userNote: '',
            selectedPersona: 1, loreBookPage: 1, collectionOrganizers: organizers,
        } as any)
        Object.assign(getDatabase(), {
            personas: [
                { name: 'User', icon: '', personaPrompt: '' },
                { name: 'Second', icon: '', personaPrompt: '' },
            ],
            loreBook: [
                { id: 'lore-one', name: 'One', data: [] },
                { id: 'lore-two', name: 'Two', data: [] },
            ],
            botPresets: [{ id: 'preset-one' }, { id: 'preset-two' }],
            modules: [{ id: 'module-one' }, { id: 'module-two' }],
            plugins: [{ name: 'plugin-one' }, { name: 'plugin-two' }],
        })
        setDatabase(getDatabase())

        const hydrated = getDatabase()
        expect(hydrated.selectedPersona).toBe(1)
        expect(hydrated.loreBookPage).toBe(1)
        expect(hydrated.collectionOrganizers).toMatchObject({
            promptPresets: { folderByItemId: { 'preset-two': 'preset-folder' }, itemOrder: ['preset-two', 'preset-one'] },
            modules: { folderByItemId: { 'module-two': 'module-folder' }, itemOrder: ['module-two', 'module-one'] },
            plugins: { folderByItemId: { 'plugin-two': 'plugin-folder' }, itemOrder: ['plugin-two', 'plugin-one'] },
        })
    })
})
