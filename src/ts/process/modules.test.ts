import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    alertWait: vi.fn(),
    decodeRPack: vi.fn<(data: Uint8Array) => Promise<Uint8Array>>(async (data) => Buffer.from(data)),
    hasher: vi.fn(async (data: Uint8Array) => `hash-${data[0]}`),
    saveAsset: vi.fn<(data: Uint8Array) => Promise<string>>(async () => 'single-write'),
    setItems: vi.fn<(entries: Array<{ key: string; value: Uint8Array }>) => Promise<void>>(async () => undefined),
}))

vi.mock('src/lang', () => ({
    language: { errors: { noData: 'no data' } },
}))
vi.mock('../alert', () => ({
    alertClear: vi.fn(),
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    alertModuleSelect: vi.fn(),
    alertNormal: vi.fn(),
    alertStore: { set: vi.fn() },
    alertWait: mocks.alertWait,
    notifySuccess: vi.fn(),
}))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(),
    getCurrentChat: vi.fn(),
    getDatabase: vi.fn(() => ({ modules: [] })),
    setCurrentCharacter: vi.fn(),
    setDatabase: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({
    AppendableBuffer: class {},
    downloadFile: vi.fn(),
    forageStorage: { setItems: mocks.setItems },
    LocalWriter: class {},
    readImage: vi.fn(),
    saveAsset: mocks.saveAsset,
    VirtualWriter: class {},
}))
vi.mock('../util', () => ({
    checkPersonaBinded: vi.fn(),
    selectSingleFile: vi.fn(),
    sleep: vi.fn(async () => undefined),
}))
vi.mock('uuid', () => ({ v4: vi.fn(() => 'new-module-id') }))
vi.mock('./lorebook.svelte', () => ({ convertExternalLorebook: vi.fn() }))
vi.mock('../media', () => ({ compressImage: vi.fn() }))
vi.mock('../rpack/rpack_js', () => ({
    decodeRPack: mocks.decodeRPack,
    encodeRPack: vi.fn(),
}))
vi.mock('../stores.svelte', () => ({
    HideIconStore: { set: vi.fn() },
    moduleBackgroundEmbedding: { set: vi.fn() },
    ReloadGUIPointer: { set: vi.fn() },
}))
vi.mock('svelte/store', () => ({ get: vi.fn(() => 0) }))
vi.mock('../interchangeability', () => ({
    convertCharacterToModule: vi.fn(),
    convertModuleToCharacter: vi.fn(),
}))
vi.mock('../characterCards', () => ({
    exportCharacterCard: vi.fn(),
    importCharacterProcess: vi.fn(),
}))
vi.mock('../parser/parser.svelte', () => ({ hasher: mocks.hasher }))

import { readModule } from './modules'

function uint32le(value: number) {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32LE(value)
    return bytes
}

function risumWithAssets(count: number) {
    const moduleData = Buffer.from(JSON.stringify({
        type: 'risuModule',
        module: {
            name: 'asset pack',
            description: '',
            id: 'old-id',
            assets: Array.from({ length: count }, (_, index) => [`asset-${index}`, '', 'png']),
        },
    }))
    const parts: Buffer[] = [Buffer.from([111, 0]), uint32le(moduleData.length), moduleData]
    for (let index = 0; index < count; index++) {
        const data = Buffer.from([index])
        parts.push(Buffer.from([1]), uint32le(data.length), data)
    }
    parts.push(Buffer.from([0]))
    return Buffer.concat(parts)
}

describe('readModule asset persistence', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.decodeRPack.mockImplementation(async (data: Uint8Array) => Buffer.from(data))
        mocks.saveAsset.mockResolvedValue('single-write')
        mocks.setItems.mockResolvedValue(undefined)
    })

    it('persists decoded assets through bounded bulk writes', async () => {
        const module = await readModule(risumWithAssets(21))

        expect(mocks.setItems).toHaveBeenCalledTimes(2)
        expect(mocks.setItems.mock.calls[0][0]).toHaveLength(20)
        expect(mocks.setItems.mock.calls[1][0]).toHaveLength(1)
        expect(mocks.saveAsset).not.toHaveBeenCalled()
        expect(module.assets?.[0][1]).toBe('assets/hash-0.png')
        expect(module.assets?.[20][1]).toBe('assets/hash-20.png')
    })

    it('uses the binary single-write path for an oversized asset', async () => {
        mocks.decodeRPack.mockImplementation(async (data: Uint8Array) => {
            if (data.length === 1 && data[0] === 0) {
                return { 0: 0, length: 32 * 1024 * 1024 + 1 } as unknown as Uint8Array
            }
            return Buffer.from(data)
        })

        const module = await readModule(risumWithAssets(1))

        expect(mocks.setItems).not.toHaveBeenCalled()
        expect(mocks.saveAsset).toHaveBeenCalledTimes(1)
        expect(module.assets?.[0][1]).toBe('single-write')
    })
})
