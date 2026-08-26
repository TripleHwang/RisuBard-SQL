import { beforeEach, describe, expect, test, vi } from 'vitest'

const validCard = (assets: any[] = []) => ({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Server character', extensions: { risuai: {} }, assets },
})

const state = vi.hoisted(() => ({
    events: [] as string[], alerts: [] as string[], doneCalls: 0, importerCalls: 0,
    completion: Promise.resolve(), isNodeServer: false, selectedFiles: null as File[] | null,
    importCharX: vi.fn(), readModule: vi.fn(), pin: vi.fn(),
    db: { statics: { imports: 0 }, characters: [] as any[] },
}))

vi.mock('./platform', () => ({ get isNodeServer() { return state.isNodeServer } }))
vi.mock('./alert', () => ({
    alertCardExport: vi.fn(), alertConfirm: vi.fn(),
    alertError: vi.fn((error) => state.alerts.push(String(error))), alertInput: vi.fn(),
    alertStore: { set: vi.fn((alert) => state.alerts.push(alert.msg)) },
    alertTOS: vi.fn(), alertWait: vi.fn(), notifyError: vi.fn((message) => state.events.push(`notify:${message}`)), notifySuccess: vi.fn(),
}))
vi.mock('./storage/database.svelte', () => ({
    appVer: 'test', defaultSdDataFunc: () => ({}), getDatabase: () => state.db,
    importPreset: vi.fn(), newChatModelDefaults: () => ({}), setDatabase: vi.fn(), setDatabaseLite: vi.fn(),
}))
vi.mock('./process/processzip', () => ({
    CharXImporter: class {
        alertInfo = false; assets = {}; cardData: string | undefined; moduleData: Uint8Array | undefined
        constructor() { state.importerCalls += 1 }
        async parse() { state.completion = new Promise<void>((resolve) => setTimeout(() => { this.cardData = JSON.stringify({ spec: 'not-v3', data: {} }); state.events.push('assets-5/5'); resolve() }, 0)) }
        async done() { state.doneCalls += 1; await state.completion }
    },
    CharXSkippableChecker: vi.fn(), CharXWriter: class {},
}))
vi.mock('./globalApi.svelte', () => ({
    AppendableBuffer: class {}, BlankWriter: class {}, LocalWriter: class {}, VirtualWriter: class {},
    checkCharOrder: vi.fn(), downloadFile: vi.fn(), forageStorage: { importCharX: (...args: any[]) => state.importCharX(...args) },
    loadAsset: vi.fn(), readImage: vi.fn(), saveAsset: vi.fn(),
}))
vi.mock('./process/modules', () => ({ exportModuleLegacy: vi.fn(), readModule: (...args: any[]) => state.readModule(...args) }))
vi.mock('./util', async (importOriginal) => ({ ...(await importOriginal<typeof import('./util')>()), selectFileByDom: vi.fn(() => state.selectedFiles) }))
vi.mock('./stores.svelte', () => ({ selectedCharID: { set: vi.fn() } }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))
vi.mock('./media', () => ({ compressImage: vi.fn(), getImageType: vi.fn() }))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn(), risuChatParser: vi.fn() }))
vi.mock('./process/files/inlays', () => ({ reencodeImage: vi.fn() }))
vi.mock('./characterVault', () => ({ pinCharacterVaultQuickAccess: (...args: any[]) => state.pin(...args) }))
vi.mock('src/lang', () => ({ language: { errors: { noData: 'invalid-data' }, importedCharacter: 'imported' } }))

import { importCharacter, importCharacterProcess } from './characterCards'

describe('CharX import completion', () => {
    beforeEach(() => {
        state.events = []; state.alerts = []; state.doneCalls = 0; state.importerCalls = 0; state.completion = Promise.resolve()
        state.isNodeServer = false; state.selectedFiles = null; state.db.statics.imports = 0; state.db.characters = []
        state.pin.mockReset(); state.importCharX.mockReset(); state.readModule.mockReset()
    })

    test('waits for delayed archive completion before validating card metadata', async () => {
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        await state.completion
        expect(state.doneCalls).toBe(1)
        expect(state.events).toEqual(['assets-5/5'])
        expect(state.alerts).toContain('invalid-data')
    })
})

describe('Node-assisted CharX import', () => {
    const serverResult = (overrides = {}) => ({
        card: validCard(), moduleBase64: null, assets: {}, excludedFiles: [], warnings: [], ...overrides,
    })

    beforeEach(() => {
        state.events = []; state.alerts = []; state.doneCalls = 0; state.importerCalls = 0; state.completion = Promise.resolve()
        state.db.statics.imports = 0; state.db.characters = []; state.pin.mockReset(); state.readModule.mockReset(); state.importCharX.mockReset()
        state.isNodeServer = true
        state.importCharX.mockResolvedValue(serverResult())
    })

    test('sends the same File to the server without constructing the browser importer', async () => {
        const file = new File(['archive'], 'REALM.CHARX')
        await importCharacterProcess({ name: file.name, data: file })
        expect(state.importCharX).toHaveBeenCalledWith(file, expect.any(Function))
        expect(state.importerCalls).toBe(0)
    })

    test('wraps a byte buffer in a Blob for the server', async () => {
        const bytes = new Uint8Array([1, 2, 3])
        await importCharacterProcess({ name: 'realm.charx', data: bytes })
        const uploaded = state.importCharX.mock.calls[0][0]
        expect(uploaded).toBeInstanceOf(Blob)
        expect(uploaded).not.toBe(bytes)
        expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(bytes)
    })

    test('rejects streams with an actionable server-import error', async () => {
        await expect(importCharacterProcess({ name: 'realm.charx', data: new ReadableStream() })).rejects.toThrow('Node CharX import requires a file or byte buffer')
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(0)
    })

    test('keeps non-Node CharX on the local importer', async () => {
        state.isNodeServer = false
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(1)
    })

    test('propagates a server rejection without local fallback', async () => {
        state.importCharX.mockRejectedValue(new Error('server broke'))
        await expect(importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })).rejects.toThrow('server broke')
        expect(state.importerCalls).toBe(0)
    })

    test('surfaces a server rejection through the import UI boundary without local fallback', async () => {
        state.importCharX.mockRejectedValue(new Error('server broke'))
        state.selectedFiles = [new File(['archive'], 'realm.charx')]
        await importCharacter()
        expect(state.alerts).toContain('Error: server broke')
        expect(state.importerCalls).toBe(0)
    })

    test('merges a server module through the existing module reader', async () => {
        state.readModule.mockResolvedValue({ trigger: [{ id: 'trigger' }], regex: [{ id: 'regex' }], lorebook: [{ key: 'lore' }] })
        state.importCharX.mockResolvedValue(serverResult({ moduleBase64: Buffer.from('module').toString('base64') }))
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.readModule).toHaveBeenCalledWith(Buffer.from('module'))
        expect(state.db.characters[0]).toMatchObject({ triggerscript: [{ id: 'trigger' }], customscript: [{ id: 'regex' }], globalLore: [{ key: 'lore' }] })
    })

    test('uses server assets during card finalization and pins the imported character', async () => {
        const assets = [{ type: 'icon', name: 'main', uri: '__asset:assets/avatar.png' }]
        state.importCharX.mockResolvedValue(serverResult({ card: validCard(assets), assets: { 'assets/avatar.png': 'assets/hash.png' } }))
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.db.characters[0].image).toBe('assets/hash.png')
        expect(state.pin).toHaveBeenCalledWith(state.db, state.db.characters[0].chaId)
    })

    test('returns the created character when requested', async () => {
        const result = await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array(), returnCharacter: true })
        expect(result).toMatchObject({ name: 'Server character' })
        expect(state.db.characters).toEqual([])
    })

    test('reports server exclusions and warnings once after finalizing', async () => {
        state.importCharX.mockImplementation(async (_file, progress) => {
            progress({ phase: 'uploading', loaded: 1, total: 2 })
            progress({ phase: 'processing', completed: 1, total: 2 })
            return serverResult({ excludedFiles: ['large.png'], warnings: ['asset skipped'] })
        })
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.alerts).toEqual(expect.arrayContaining(['Uploading CharX…', 'Processing CharX on server…', 'Finalizing character…']))
        expect(state.events).toEqual(['notify:large.png\nasset skipped'])
    })

    test.each(['portrait.jpg', 'portrait.jpeg'])('keeps %s on the local importer', async (name) => {
        await importCharacterProcess({ name, data: new Uint8Array() })
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(1)
    })
})
