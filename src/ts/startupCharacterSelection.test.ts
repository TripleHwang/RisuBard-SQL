import { describe, expect, test, vi } from 'vitest'
import { createStartupCharacterSelectionQueue } from './startupCharacterSelection'

describe('startup character selection queue', () => {
    test('keeps the prior selection until startup can atomically activate the newest hydrated target', async () => {
        const queue = createStartupCharacterSelectionQueue()
        let selectedCharacterId: string | undefined
        const safeSelect = vi.fn((index: number) => {
            selectedCharacterId = index === 1 ? 'first' : 'latest'
        })
        const fullSelect = vi.fn()
        let resolveFirst: (value: boolean) => void = () => {}
        let resolveLatest: (value: boolean) => void = () => {}
        const firstHydration = new Promise<boolean>((resolve) => { resolveFirst = resolve })
        const latestHydration = new Promise<boolean>((resolve) => { resolveLatest = resolve })

        const first = queue.select({
            ready: false,
            characterId: 'first',
            index: 1,
            hydrate: () => firstHydration,
            findIndex: (id) => id === 'first' ? 4 : -1,
            safeSelect,
            fullSelect,
        })
        expect(safeSelect).not.toHaveBeenCalled()
        expect(fullSelect).not.toHaveBeenCalled()

        const latest = queue.select({
            ready: false,
            characterId: 'latest',
            index: 2,
            hydrate: () => latestHydration,
            findIndex: (id) => id === 'latest' ? 7 : -1,
            safeSelect,
            fullSelect,
        })
        resolveLatest(true)
        expect(await latest).toBe(false)
        expect(selectedCharacterId).toBeUndefined()
        expect(safeSelect).not.toHaveBeenCalled()
        expect(fullSelect).not.toHaveBeenCalled()

        // Deferred startup must not expose a partial target. The old screen
        // remains selected until the complete activation can run.
        expect(queue.resume({ ready: false, findIndex: vi.fn(), fullSelect })).toBe(false)
        expect(selectedCharacterId).toBeUndefined()
        expect(fullSelect).not.toHaveBeenCalled()

        expect(queue.resume({ ready: true, findIndex: (id) => id === 'latest' ? 7 : -1, fullSelect })).toBe(true)
        expect(fullSelect).toHaveBeenCalledWith(7)
        expect(queue.resume({ ready: true, findIndex: vi.fn(), fullSelect })).toBe(false)

        resolveFirst(true)
        expect(await first).toBe(false)
        expect(safeSelect).not.toHaveBeenCalled()
    })

    test('hydrates before activating even when startup is ready', async () => {
        const queue = createStartupCharacterSelectionQueue()
        const safeSelect = vi.fn()
        const fullSelect = vi.fn()

        await queue.select({
            ready: false,
            characterId: 'older-deferred',
            index: 1,
            hydrate: async () => true,
            findIndex: () => 1,
            safeSelect,
            fullSelect,
        })

        let resolveHydration!: (value: boolean) => void
        const hydration = new Promise<boolean>((resolve) => { resolveHydration = resolve })
        const select = queue.select({
            ready: true,
            characterId: 'ready',
            index: 3,
            hydrate: () => hydration,
            findIndex: () => 3,
            safeSelect,
            fullSelect,
        })
        expect(fullSelect).not.toHaveBeenCalled()
        expect(queue.resume({ ready: true, findIndex: () => 1, fullSelect })).toBe(false)
        resolveHydration(true)
        expect(await select).toBe(true)
        expect(safeSelect).not.toHaveBeenCalled()
        expect(fullSelect).toHaveBeenCalledWith(3)
        expect(queue.resume({ ready: true, findIndex: vi.fn(), fullSelect })).toBe(false)
    })

    test('clears a latest failed deferred selection so resume cannot activate it', async () => {
        const queue = createStartupCharacterSelectionQueue()
        const fullSelect = vi.fn()
        const onFailure = vi.fn()

        await expect(queue.select({
            ready: false,
            characterId: 'failed',
            index: 2,
            hydrate: async () => false,
            findIndex: () => 2,
            safeSelect: vi.fn(),
            fullSelect,
            onFailure,
        })).resolves.toBe(false)

        expect(onFailure).toHaveBeenCalledOnce()
        expect(queue.resume({ ready: true, findIndex: () => 2, fullSelect })).toBe(false)
        expect(fullSelect).not.toHaveBeenCalled()
    })
})
