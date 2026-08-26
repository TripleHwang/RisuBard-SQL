import { describe, expect, it, vi } from 'vitest'
import { BoundedLruCache } from './lruCache'

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
})
