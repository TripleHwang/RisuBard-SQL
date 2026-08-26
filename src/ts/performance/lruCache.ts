import { notifySaverCachePressure, reclaimableCaches } from './saverMode'

/** Small ownership-aware LRU. Values are only retained by the cache itself. */
export class BoundedLruCache<K, V> {
    private values = new Map<K, V>()
    private currentBytes = 0
    private readonly unregister: () => void

    constructor(
        private readonly maxEntries: number,
        private readonly onEvict?: (value: V) => void,
        private readonly maxBytes = Number.POSITIVE_INFINITY,
        private readonly sizeOf: (value: V) => number = () => 0,
    ) {
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
        if (prior !== undefined) this.removeValue(prior)
        this.values.delete(key)
        this.values.set(key, value)
        this.currentBytes += this.valueSize(value)
        const entryEvicted = this.shrinkTo(this.maxEntries)
        const byteEvicted = this.shrinkBytes()
        if (entryEvicted || byteEvicted) notifySaverCachePressure()
    }

    shrinkTo(limit: number): boolean {
        let evicted = false
        while (this.values.size > Math.max(0, limit)) {
            const key = this.values.keys().next().value as K
            const value = this.values.get(key)
            this.values.delete(key)
            if (value !== undefined) this.removeValue(value)
            evicted = true
        }
        return evicted
    }

    clear(): void {
        for (const value of this.values.values()) this.evict(value)
        this.values.clear()
        this.currentBytes = 0
    }

    dispose(): void { this.unregister(); this.clear() }
    private shrinkBytes(): boolean {
        let evicted = false
        while (this.currentBytes > this.maxBytes && this.values.size > 0) {
            const key = this.values.keys().next().value as K
            const value = this.values.get(key)
            this.values.delete(key)
            if (value !== undefined) this.removeValue(value)
            evicted = true
        }
        return evicted
    }

    private valueSize(value: V): number { return Math.max(0, this.sizeOf(value) || 0) }
    private removeValue(value: V): void { this.currentBytes -= this.valueSize(value); this.evict(value) }
    private evict(value: V): void { try { this.onEvict?.(value) } catch (error) { console.warn('[lru] eviction failed', error) } }
}
