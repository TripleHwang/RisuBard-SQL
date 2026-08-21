import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({
    events: [] as string[],
    doneCalls: 0,
    completion: Promise.resolve(),
    db: {
        statics: { imports: 0 },
        characters: [],
    },
}))

vi.mock('./alert', () => ({
    alertCardExport: vi.fn(),
    alertConfirm: vi.fn(),
    alertError: vi.fn(() => state.events.push('error')),
    alertInput: vi.fn(),
    alertStore: { set: vi.fn() },
    alertTOS: vi.fn(),
    alertWait: vi.fn(),
    notifyError: vi.fn(),
    notifySuccess: vi.fn(),
}))

vi.mock('./storage/database.svelte', () => ({
    appVer: 'test',
    defaultSdDataFunc: () => ({}),
    getDatabase: () => state.db,
    importPreset: vi.fn(),
    newChatModelDefaults: () => ({}),
    setDatabase: vi.fn(),
    setDatabaseLite: vi.fn(),
}))

vi.mock('./process/processzip', () => ({
    CharXImporter: class {
        alertInfo = false
        assets = {}
        cardData: string | undefined
        moduleData: Uint8Array | undefined

        async parse() {
            state.completion = new Promise<void>((resolve) => {
                setTimeout(() => {
                    this.cardData = JSON.stringify({ spec: 'not-v3', data: {} })
                    state.events.push('assets-5/5')
                    resolve()
                }, 0)
            })
        }

        async done() {
            state.doneCalls += 1
            await state.completion
        }
    },
    CharXSkippableChecker: vi.fn(),
    CharXWriter: class {},
}))

vi.mock('./globalApi.svelte', () => ({
    AppendableBuffer: class {},
    BlankWriter: class {},
    LocalWriter: class {},
    VirtualWriter: class {},
    checkCharOrder: vi.fn(),
    downloadFile: vi.fn(),
    forageStorage: {},
    loadAsset: vi.fn(),
    readImage: vi.fn(),
    saveAsset: vi.fn(),
}))

vi.mock('./process/modules', () => ({
    exportModuleLegacy: vi.fn(),
    readModule: vi.fn(),
}))

vi.mock('./stores.svelte', () => ({ selectedCharID: { set: vi.fn() } }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))
vi.mock('./media', () => ({ compressImage: vi.fn(), getImageType: vi.fn() }))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn(), risuChatParser: vi.fn() }))
vi.mock('./process/files/inlays', () => ({ reencodeImage: vi.fn() }))
vi.mock('./characterVault', () => ({ pinCharacterVaultQuickAccess: vi.fn() }))
vi.mock('src/lang', () => ({
    language: {
        errors: { noData: 'invalid-data' },
        importedCharacter: 'imported',
    },
}))

import { importCharacterProcess } from './characterCards'

describe('CharX import completion', () => {
    beforeEach(() => {
        state.events = []
        state.doneCalls = 0
        state.completion = Promise.resolve()
        state.db.statics.imports = 0
    })

    test('waits for delayed archive completion before validating card metadata', async () => {
        await importCharacterProcess({
            name: 'realm.charx',
            data: new Uint8Array(),
        })
        await state.completion

        expect(state.doneCalls).toBe(1)
        expect(state.events).toEqual(['assets-5/5', 'error'])
    })
})
