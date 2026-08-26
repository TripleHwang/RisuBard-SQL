import { describe, expect, it, vi } from 'vitest'
import { BoundedLruCache } from './lruCache'
import { get } from 'svelte/store'
import { saverModeStore } from './saverMode'

describe('BoundedLruCache', () => {
    it('evicts the least recently used value and clears registered ownership', () => {
        const evicted = vi.fn()
        const cache = new BoundedLruCache<string, string>(2, evicted)
        cache.set('a', 'A')
        cache.set('b', 'B')
        cache.get('a')
        cache.set('c', 'C')
        expect(cache.get('b')).toBeUndefined()
        expect(evicted).toHaveBeenCalledWith('B')
        cache.clear()
        expect(evicted).toHaveBeenCalledWith('A')
        expect(evicted).toHaveBeenCalledWith('C')
    })

    it('notifies deterministic cache pressure when capacity eviction occurs', async () => {
        const cache = new BoundedLruCache<string, string>(1)
        cache.set('a', 'A')
        cache.set('b', 'B')
        await Promise.resolve()
        await Promise.resolve()
        expect(get(saverModeStore)).toBe(true)
    })

    it('also evicts by bounded byte budget', () => {
        const cache = new BoundedLruCache<string, string>(10, undefined, 3, value => value.length)
        cache.set('a', 'aa')
        cache.set('b', 'bb')
        expect(cache.get('a')).toBeUndefined()
        expect(cache.get('b')).toBe('bb')
    })
})
