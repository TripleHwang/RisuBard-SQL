import { beforeEach, describe, expect, test, vi } from 'vitest'

let mockDb: any
let currentChat: any

vi.mock('src/ts/storage/database.svelte', () => ({
    getDatabase: () => mockDb,
    getCurrentChat: () => currentChat,
}))

import { getGenerationModelString } from './modelString'

beforeEach(() => {
    mockDb = {
        aiModel: 'legacy-model',
        nodeOnlyModelModeLock: 'none',
        modelPresets: [{ id: 'preset-main', name: 'Preset Main' }],
    }
    currentChat = {
        useModelPreset: false,
        modelBinding: { main: 'preset-main' },
    }
})

describe('getGenerationModelString', () => {
    test('shows the resolved preset when preset mode is globally forced', () => {
        mockDb.nodeOnlyModelModeLock = 'preset'

        expect(getGenerationModelString()).toBe('Preset Main')
    })

    test('shows the legacy model when legacy mode is globally forced', () => {
        mockDb.nodeOnlyModelModeLock = 'legacy'
        currentChat.useModelPreset = true

        expect(getGenerationModelString()).toBe('legacy-model')
    })
})
