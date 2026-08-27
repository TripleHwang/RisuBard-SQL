import { describe, expect, test, vi } from 'vitest'
import { createStartupCharacterSelectionQueue } from './startupCharacterSelection'

describe('startup character selection queue', () => {
    test('waits for the latest targeted full-record hydration before selecting and mutating', async () => {
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
        expect(selectedCharacterId).toBe('latest')
        expect(safeSelect).toHaveBeenCalledOnce()
        expect(safeSelect).toHaveBeenCalledWith(7)
        expect(fullSelect).not.toHaveBeenCalled()

        // A declined or failed deferred hydration keeps the UI selection but
        // must not perform the queued character/chat mutation.
        expect(queue.resume({ ready: false, findIndex: vi.fn(), fullSelect })).toBe(false)
        expect(selectedCharacterId).toBe('latest')
        expect(fullSelect).not.toHaveBeenCalled()

        expect(queue.resume({ ready: true, findIndex: (id) => id === 'latest' ? 7 : -1, fullSelect })).toBe(true)
        expect(fullSelect).toHaveBeenCalledWith(7)
        expect(queue.resume({ ready: true, findIndex: vi.fn(), fullSelect })).toBe(false)

        resolveFirst(true)
        expect(await first).toBe(false)
        expect(safeSelect).toHaveBeenCalledOnce()
    })

    test('runs the ready path immediately without waiting for targeted hydration', async () => {
        const queue = createStartupCharacterSelectionQueue()
        const safeSelect = vi.fn()
        const fullSelect = vi.fn()

        expect(await queue.select({
            ready: true,
            characterId: 'ready',
            index: 3,
            hydrate: vi.fn(),
            findIndex: vi.fn(),
            safeSelect,
            fullSelect,
        })).toBe(true)
        expect(safeSelect).not.toHaveBeenCalled()
        expect(fullSelect).toHaveBeenCalledWith(3)
        expect(queue.resume({ ready: true, findIndex: vi.fn(), fullSelect })).toBe(false)
    })
})
