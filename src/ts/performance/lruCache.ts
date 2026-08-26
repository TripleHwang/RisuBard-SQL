import { reclaimableCaches } from './saverMode'

/** Small ownership-aware LRU. Values are only retained by the cache itself. */
export class BoundedLruCache<K, V> {
    private values = new Map<K, V>()
    private readonly unregister: () => void

    constructor(private readonly maxEntries: number, private readonly onEvict?: (value: V) => void) {
        this.unregister = reclaimableCaches.register(() => this.clear())
    }

    get(key: K): V | undefined {
        const value = this.values.get(key)
        if (value === undefined) return undefined
        this.values.delete(key)
        this.values.set(key, value)
        return value
    }

    set(key: K, value: V): void {
        const prior = this.values.get(key)
        if (prior !== undefined) this.evict(prior)
        this.values.delete(key)
        this.values.set(key, value)
        this.shrinkTo(this.maxEntries)
    }

    shrinkTo(limit: number): void {
        while (this.values.size > Math.max(0, limit)) {
            const key = this.values.keys().next().value as K
            const value = this.values.get(key)
            this.values.delete(key)
            if (value !== undefined) this.evict(value)
        }
    }

    clear(): void {
        for (const value of this.values.values()) this.evict(value)
        this.values.clear()
    }

    dispose(): void { this.unregister(); this.clear() }
    private evict(value: V): void { try { this.onEvict?.(value) } catch (error) { console.warn('[lru] eviction failed', error) } }
}
