import { describe, expect, test, vi } from 'vitest'

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} },
    selectedCharID: { subscribe: () => () => {} },
    selIdState: { selId: -1 },
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: vi.fn(),
    saveAsset: vi.fn(async () => ''),
}))
vi.mock('../alert', () => ({ notifySuccess: vi.fn(), alertError: vi.fn() }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: vi.fn() }))

const { getDatabase, setDatabase } = await import('./database.svelte')

describe('persona selection database migration', () => {
    test('rebuilds an empty persona store and clamps a stale selection', () => {
        setDatabase({
            characters: [],
            formatingOrder: ['main'],
            loreBook: [],
            personas: [],
            selectedPersona: 99,
            username: 'User',
            userIcon: 'user.png',
            userNote: '',
        } as any)

        const db = getDatabase()
        expect(db.personas).toHaveLength(1)
        expect(db.personas[0]).toMatchObject({ name: 'User', icon: 'user.png' })
        expect(db.selectedPersona).toBe(0)
    })

    test('clamps an out-of-range selection to the last existing persona', () => {
        setDatabase({
            characters: [],
            formatingOrder: ['main'],
            loreBook: [],
            personas: [
                { name: 'First', icon: '', personaPrompt: '' },
                { name: 'Second', icon: '', personaPrompt: '' },
            ],
            selectedPersona: 99,
            username: 'User',
            userIcon: '',
            userNote: '',
        } as any)

        expect(getDatabase().selectedPersona).toBe(1)
    })
})
