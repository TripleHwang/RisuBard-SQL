import { describe, expect, test, vi } from 'vitest'
import { createStartupCharacterSelectionQueue } from './startupCharacterSelection'

describe('startup character selection queue', () => {
    test('keeps summary selection responsive while queueing only the latest pending character', () => {
        const queue = createStartupCharacterSelectionQueue()
        let selectedCharacterId: string | undefined
        const safeSelect = vi.fn((index: number) => {
            selectedCharacterId = index === 1 ? 'first' : 'latest'
        })
        const fullSelect = vi.fn()

        expect(queue.select({ ready: false, characterId: 'first', index: 1, safeSelect, fullSelect })).toBe(false)
        expect(queue.select({ ready: false, characterId: 'latest', index: 2, safeSelect, fullSelect })).toBe(false)
        expect(safeSelect).toHaveBeenNthCalledWith(1, 1)
        expect(safeSelect).toHaveBeenNthCalledWith(2, 2)
        expect(selectedCharacterId).toBe('latest')
        expect(fullSelect).not.toHaveBeenCalled()

        // A declined or failed deferred hydration keeps the UI selection but
        // must not perform the queued character/chat mutation.
        expect(queue.resume({ ready: false, findIndex: vi.fn(), fullSelect })).toBe(false)
        expect(selectedCharacterId).toBe('latest')
        expect(fullSelect).not.toHaveBeenCalled()

        expect(queue.resume({ ready: true, findIndex: (id) => id === 'latest' ? 7 : -1, fullSelect })).toBe(true)
        expect(fullSelect).toHaveBeenCalledWith(7)
        expect(queue.resume({ ready: true, findIndex: vi.fn(), fullSelect })).toBe(false)
    })

    test('runs the ready path immediately without queueing a duplicate activation', () => {
        const queue = createStartupCharacterSelectionQueue()
        const safeSelect = vi.fn()
        const fullSelect = vi.fn()

        expect(queue.select({ ready: false, characterId: 'old-pending', index: 1, safeSelect, fullSelect })).toBe(false)
        expect(queue.select({ ready: true, characterId: 'ready', index: 3, safeSelect, fullSelect })).toBe(true)
        expect(safeSelect).toHaveBeenCalledOnce()
        expect(fullSelect).toHaveBeenCalledWith(3)
        expect(queue.resume({ ready: true, findIndex: vi.fn(), fullSelect })).toBe(false)
    })
})
