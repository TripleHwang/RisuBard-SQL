import { beforeEach, describe, expect, test, vi } from 'vitest'
import { runInNewContext } from 'node:vm'

const validCard = (assets: any[] = []) => ({
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: { name: 'Server character', extensions: { risuai: {} }, assets },
})

const state = vi.hoisted(() => ({
    events: [] as string[], alerts: [] as string[], waitAlerts: [] as string[], doneCalls: 0, importerCalls: 0,
    completion: Promise.resolve(), localCardData: JSON.stringify({ spec: 'not-v3', data: {} }), isNodeServer: false, selectedFiles: null as File[] | null,
    importCharX: vi.fn(), readModule: vi.fn(), pin: vi.fn(),
    db: { statics: { imports: 0 }, characters: [] as any[] },
}))

vi.mock('./platform', () => ({ get isNodeServer() { return state.isNodeServer } }))
vi.mock('./alert', () => ({
    alertCardExport: vi.fn(), alertConfirm: vi.fn(),
    alertError: vi.fn((error) => state.alerts.push(String(error))), alertInput: vi.fn(),
    alertStore: { set: vi.fn((alert) => state.waitAlerts.push(alert.msg)) },
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
        async parse() { state.completion = new Promise<void>((resolve) => setTimeout(() => { this.cardData = state.localCardData; state.events.push('assets-5/5'); resolve() }, 0)) }
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
vi.mock('./stores.svelte', () => ({ selectedCharID: { set: vi.fn(), subscribe: vi.fn(() => () => undefined) } }))
vi.mock('./routing', () => ({ openSettings: vi.fn(), SettingsRoute: {} }))
vi.mock('./media', () => ({ compressImage: vi.fn(), getImageType: vi.fn() }))
vi.mock('./parser/parser.svelte', () => ({ hasher: vi.fn(), risuChatParser: vi.fn() }))
vi.mock('./process/files/inlays', () => ({ reencodeImage: vi.fn() }))
vi.mock('./characterVault', () => ({ pinCharacterVaultQuickAccess: (...args: any[]) => state.pin(...args) }))
vi.mock('src/lang', () => ({ language: { errors: { noData: 'invalid-data' }, importedCharacter: 'imported' } }))

import { createBaseV2, createBaseV3, importCharacter, importCharacterProcess } from './characterCards'

function cardFixture(spec: 'chara_card_v2'|'chara_card_v3', risuai: Record<string, unknown>|undefined, postHistory = 'legacy card global note') {
    return {
        spec,
        spec_version: spec === 'chara_card_v2' ? '2.0' : '3.0',
        data: {
            name: 'Legacy card', description: '', personality: '', scenario: '', first_mes: '', mes_example: '',
            creator_notes: '', system_prompt: '', post_history_instructions: postHistory,
            alternate_greetings: [], tags: [], creator: '', character_version: '',
            extensions: risuai === undefined ? {} : { risuai },
        },
    }
}

async function importFixture(card: ReturnType<typeof cardFixture>) {
    state.db.characters = []
    await importCharacterProcess({
        name: 'fixture.json',
        data: Buffer.from(JSON.stringify(card)),
    })
    return state.db.characters[0]
}

describe('CharX import completion', () => {
    beforeEach(() => {
        state.events = []; state.alerts = []; state.waitAlerts = []; state.doneCalls = 0; state.importerCalls = 0; state.completion = Promise.resolve()
        state.localCardData = JSON.stringify({ spec: 'not-v3', data: {} }); state.isNodeServer = false; state.selectedFiles = null; state.db.statics.imports = 0; state.db.characters = []
        state.pin.mockReset(); state.importCharX.mockReset(); state.readModule.mockReset()
    })

    test('waits for delayed archive completion before validating card metadata', async () => {
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        await state.completion
        expect(state.doneCalls).toBe(1)
        expect(state.events).toEqual(['assets-5/5'])
        expect(state.alerts).toContain('invalid-data')
        expect(state.waitAlerts).toEqual(['Loading... (Reading)'])
    })
})

describe('Node-assisted CharX import', () => {
    const serverResult = (overrides = {}) => ({
        card: validCard(), moduleBase64: null, assets: {}, excludedFiles: [], warnings: [], ...overrides,
    })

    beforeEach(() => {
        state.events = []; state.alerts = []; state.waitAlerts = []; state.doneCalls = 0; state.importerCalls = 0; state.completion = Promise.resolve()
        state.localCardData = JSON.stringify(validCard()); state.db.statics.imports = 0; state.db.characters = []; state.pin.mockReset(); state.readModule.mockReset(); state.importCharX.mockReset()
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

    test('rejects stream-like input from another realm before server upload', async () => {
        const foreignStream = { getReader() { return {} } } as any
        await expect(importCharacterProcess({ name: 'realm.charx', data: foreignStream })).rejects.toThrow('Node CharX import requires a file or byte buffer')
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(0)
    })

    test('wraps exact bytes from a foreign Uint8Array in a Blob', async () => {
        const foreignBytes = runInNewContext('new Uint8Array([4, 5, 6])') as Uint8Array
        expect(foreignBytes).not.toBeInstanceOf(Uint8Array)
        await importCharacterProcess({ name: 'realm.charx', data: foreignBytes })
        const uploaded = state.importCharX.mock.calls[0][0]
        expect(uploaded).toBeInstanceOf(Blob)
        expect(new Uint8Array(await uploaded.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]))
    })

    test('keeps non-Node CharX on the local importer', async () => {
        state.isNodeServer = false
        await importCharacterProcess({ name: 'realm.charx', data: new Uint8Array() })
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(1)
        expect(state.waitAlerts).toEqual(['Loading... (Reading)'])
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
        expect(state.waitAlerts).toEqual(['Uploading CharX…', 'Processing CharX on server…', 'Finalizing character…'])
        expect(state.events).toEqual(['notify:large.png\nasset skipped'])
    })

    test.each(['portrait.jpg', 'portrait.jpeg'])('keeps %s on the local importer', async (name) => {
        await importCharacterProcess({ name, data: new Uint8Array() })
        expect(state.importCharX).not.toHaveBeenCalled()
        expect(state.importerCalls).toBe(1)
        expect(state.waitAlerts).toEqual(['Loading... (Reading)'])
    })
})

describe('legacy character-card replace-global-note compatibility', () => {
    test.each(['chara_card_v2', 'chara_card_v3'] as const)('restores legacy replaceGlobalNote from %s cards with a Risu extension that does not own it', async (spec) => {
        const imported = await importFixture(cardFixture(spec, {}))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'legacy card global note',
            replaceGlobalNote: 'legacy card global note',
        })
    })

    test('does not fall back when a new card explicitly owns an empty replaceGlobalNote', async () => {
        const imported = await importFixture(cardFixture('chara_card_v3', { replaceGlobalNote: '' }, 'standard post history'))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'standard post history',
            replaceGlobalNote: '',
        })
    })

    test.each(['chara_card_v2', 'chara_card_v3'] as const)('does not create a Risu replaceGlobalNote for ordinary %s cards', async (spec) => {
        const imported = await importFixture(cardFixture(spec, undefined, 'standard post history'))

        expect(imported).toMatchObject({
            postHistoryInstructions: 'standard post history',
            replaceGlobalNote: '',
        })
    })

    test('imports Risu module extension fields through the public card lifecycle', async () => {
        const imported = await importFixture(cardFixture('chara_card_v3', {
            moduleNamespace: 'fixture-namespace', hideChatIcon: true,
        }, ''))

        expect(imported).toMatchObject({ moduleNamespace: 'fixture-namespace', hideChatIcon: true })
    })
})

describe('public character-card lifecycle round-trips', () => {
    test.each([
        ['v2', createBaseV2],
        ['v3', createBaseV3],
    ] as const)('preserves Risu extensions and post-history instructions through %s export, import, and re-export', async (_spec, createCard) => {
        const source = {
            name: 'Lifecycle fixture', globalLore: [], loreExt: {},
            postHistoryInstructions: 'standard post-history instructions',
            replaceGlobalNote: 'explicit Risu global-note replacement',
            moduleNamespace: 'lifecycle-namespace',
            hideChatIcon: true,
        } as any

        const imported = await importFixture(createCard(source) as any)
        const reexported = createCard(imported)

        expect(imported).toMatchObject({
            postHistoryInstructions: source.postHistoryInstructions,
            replaceGlobalNote: source.replaceGlobalNote,
            moduleNamespace: source.moduleNamespace,
            hideChatIcon: source.hideChatIcon,
        })
        expect(reexported.data.post_history_instructions).toBe(source.postHistoryInstructions)
        expect(reexported.data.extensions.risuai).toMatchObject({
            replaceGlobalNote: source.replaceGlobalNote,
            moduleNamespace: source.moduleNamespace,
            hideChatIcon: source.hideChatIcon,
        })
    })
})
