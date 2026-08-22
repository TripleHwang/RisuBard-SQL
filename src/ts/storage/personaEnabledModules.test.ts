import { describe, expect, it, vi } from 'vitest'

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

const databaseModule = await import('./database.svelte')
const {
    ensurePersonaIds,
    normalizeModuleEntries,
    normalizePersonaEnabledModules,
} = databaseModule

describe('persona module storage normalization', () => {
    it('skips null persisted persona and module ID entries', () => {
        expect(normalizePersonaEnabledModules(
            {
                'persona-a': ['module-b', null, 'module-a', 'module-a'],
                'deleted-persona': ['module-a'],
            },
            [null, { id: 'persona-a', name: 'A', icon: '', personaPrompt: '' }],
            [null, 'module-a', undefined, 'module-b'],
        )).toEqual({ 'persona-a': ['module-a', 'module-b'] })
    })

    it('assigns IDs only to valid persona objects and preserves existing IDs', () => {
        const existing = { id: 'existing-id', name: 'Existing', icon: '', personaPrompt: '' }
        const legacy = { name: 'Legacy', icon: '', personaPrompt: '' }
        expect(ensurePersonaIds([null, existing, legacy], () => 'generated-id')).toEqual([
            existing,
            expect.objectContaining({ id: 'generated-id' }),
        ])
        expect(existing.id).toBe('existing-id')
    })

    it('removes null persisted module entries', () => {
        const module = { id: 'module-a', name: 'A', description: '' }
        expect(normalizeModuleEntries([null, module, undefined])).toEqual([module])
    })
})
