import { describe, expect, test, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} },
    selectedCharID: { subscribe: (run: (value: number) => void) => { run(0); return () => {} }, set: () => {}, update: () => {} },
    selIdState: { selId: -1 },
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: () => Promise.resolve(''),
    globalFetch: () => Promise.resolve(),
    fetchNative: () => Promise.resolve(),
    readImage: () => Promise.resolve(),
    requestImmediateSave: () => Promise.resolve(),
    toGetter: (value: unknown) => value,
}))

vi.mock('../alert', () => ({ notifySuccess: () => {}, alertError: () => {} }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: () => {} }))
vi.mock('../plugins/apiV3/v3.svelte', () => ({ loadV3Plugins: () => Promise.resolve() }))
vi.mock('../plugins/apiV3/transpiler', () => ({ pluginCodeTranspiler: () => '' }))
vi.mock('../plugins/pluginUpdate', () => ({ runPluginUpdate: () => Promise.resolve() }))
vi.mock('../builtin/pagefold', () => ({ loadBuiltInPageFoldPlugin: () => Promise.resolve(), PAGEFOLD_PLUGIN_NAME: 'pagefold' }))

const storesModule = await import('../stores.svelte')
const { getV2PluginAPIs } = await import('../plugins/plugins.svelte')
const { buildSqlDirtyCommit } = await import('./sql/sqlDirtyCommit')

describe('trusted public full replacements', () => {
    test('mark complete character and chat bodies for SQL replacement persistence', async () => {
        const replacement = {
            chaId: 'character-a',
            name: 'Replacement character',
            description: 'full character body',
            chats: [{
                id: 'chat-a',
                name: 'Replacement chat',
                note: 'full chat body',
                localLore: [{ key: 'preserved lore' }],
                message: [{ chatId: 'message-a', role: 'user', data: 'preserved message' }],
            }],
        } as any

        const { DBState } = storesModule as any
        DBState.db = {
            characters: [{
                chaId: 'character-a',
                name: 'Existing character',
                chats: [{ id: 'chat-a', name: 'Existing chat', note: '', localLore: [], message: [] }],
            }],
            botPresets: [],
            pluginCustomStorage: {},
        }

        const api = getV2PluginAPIs()
        api.setChar(replacement) // also the API V3 setChar alias
        await api.setDatabase({ characters: [replacement] })

        const commit = buildSqlDirtyCommit(DBState.db, {
            rootKeys: [],
            characterIds: ['character-a'],
            chats: [{ characterId: 'character-a', chatId: 'chat-a', manifest: false }],
            messages: [],
            messageManifestChatIds: [],
            messageDeletes: [],
            pluginStorageKeys: [],
            presetIds: [],
        }, 7)

        expect(commit.characters).toEqual([expect.objectContaining({
            replaceBody: true,
            data: expect.objectContaining({ description: 'full character body' }),
        })])
        expect(commit.chats).toEqual([expect.objectContaining({
            replaceBody: true,
            data: expect.objectContaining({ note: 'full chat body', localLore: [{ key: 'preserved lore' }] }),
        })])
    })
})
