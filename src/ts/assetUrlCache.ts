/**
 * Byte-bounded, least-recently-used cache of asset object URLs.
 *
 * What it replaces: an append-only `{ origin: string[], res: Uint8Array[] }`
 * pair in globalApi that kept every asset byte a session ever touched, looked
 * entries up with a linear `indexOf`, and re-encoded each hit into a
 * `data:image/png;base64,` string roughly 4/3 the size of the binary. Nothing
 * was ever released.
 *
 * What it does instead: it copies each asset into a `Blob` once, hands out the
 * `blob:` URL, and drops its own reference to the bytes. Blob backing store
 * lives outside the JS heap -- on iOS Safari that is the difference between a
 * tab that survives a long chat and one the OS kills -- so bounding the number
 * of live blobs is what actually bounds the memory.
 *
 * ## Eviction has to be safe for whoever is still holding the URL
 *
 * Revoking an object URL that something is still about to load from produces a
 * broken image. The holders are:
 *
 *  - A mounted `<img>`/`<audio>` whose load has already finished. Revoking is
 *    harmless here: the resource is already decoded, and the element keeps
 *    displaying it.
 *  - A consumer that received the URL microseconds ago and has not assigned it
 *    to an element yet, or has assigned it and the load is still in flight.
 *    Revoking here *does* break it.
 *  - A long-lived string cache -- `fileSrcCache` in parser.svelte.ts is one --
 *    that will re-emit the same string into freshly built HTML much later.
 *
 * So eviction is split in two. Unlinking from the map is immediate, which is
 * what enforces the bound and what guarantees the cache can never hand the URL
 * out again. The `revokeObjectURL` call is deferred until the URL has been in
 * a consumer's hands for a full grace window, which covers the second case. The
 * third case is covered by announcing every eviction, so a string cache can
 * drop its copy at the moment the entry leaves and re-resolve on next use.
 *
 * Consequence worth stating plainly: live blob bytes are bounded by
 * `maxBytes` plus whatever was handed out inside the last `graceMs`, and they
 * settle back to `maxBytes` once those hand-outs age out. `stats()` reports
 * both halves separately rather than hiding the transient.
 */

export interface AssetUrlCacheOptions {
    /** Ceiling on the bytes held by entries reachable through the cache. */
    maxBytes: number
    /**
     * How long an object URL stays alive after its last hand-out. This is the
     * window a consumer has to actually load from a URL it was just given.
     */
    graceMs: number
    /** Reads the raw asset. Resolving null/undefined means "not present". */
    load: (loc: string) => Promise<Uint8Array | null | undefined>
    createObjectURL?: (blob: Blob) => string
    revokeObjectURL?: (url: string) => void
    now?: () => number
    schedule?: (fn: () => void, ms: number) => void
    /** Every failure goes here. Nothing is swallowed. */
    onError?: (loc: string, error: unknown) => void
    useServiceWorker?: () => boolean
    swFetch?: typeof fetch
}

export interface AssetUrlCacheStats {
    /** Bytes held by entries that are still reachable through the cache. */
    residentBytes: number
    /** Bytes of evicted entries whose object URL has not been revoked yet. */
    pendingRevokeBytes: number
    entries: number
    evictions: number
    revocations: number
}

export type AssetUrlEvictionListener = (loc: string, url: string) => void

export interface AssetUrlCache {
    /** Resolves to a URL usable as an element source, or '' if it could not. */
    getFileSrc(loc: string): Promise<string>
    /** Forgets one asset, e.g. because its bytes were overwritten. */
    invalidate(loc: string): void
    clear(): void
    stats(): AssetUrlCacheStats
    subscribeEviction(listener: AssetUrlEvictionListener): () => void
}

/**
 * Process-wide eviction subscribers.
 *
 * A holder that caches URL strings -- the parser's second-level map -- needs to
 * hear about evictions, but it has no reference to the cache instance, which
 * lives in globalApi and cannot be imported from here without a cycle. So the
 * subscription is exported from this module and every instance publishes to it.
 */
const globalEvictionListeners = new Set<AssetUrlEvictionListener>()

/**
 * Called with (loc, url) the moment an asset's object URL leaves the cache. The
 * URL is still live at call time but will be revoked shortly; drop any copy of
 * it and re-resolve through getFileSrc when you next need one.
 */
export function subscribeAssetUrlEviction(listener: AssetUrlEvictionListener): () => void {
    globalEvictionListeners.add(listener)
    return () => { globalEvictionListeners.delete(listener) }
}

/**
 * The old code labelled every asset `image/png` regardless of what it was, and
 * relied on browser sniffing to make audio and video work anyway. Blob URLs are
 * sniffed too, but an accurate type is free here, so use the extension when it
 * is recognised and fall back to the old label when it is not -- never worse
 * than the behaviour being replaced.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    bmp: 'image/bmp',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    m4a: 'audio/mp4',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
}

function mimeTypeFor(loc: string): string {
    const lastDot = loc.lastIndexOf('.')
    if (lastDot === -1) {
        return 'image/png'
    }
    const extension = loc.slice(lastDot + 1).toLowerCase()
    return MIME_BY_EXTENSION[extension] ?? 'image/png'
}

interface CacheEntry {
    loc: string
    url: string
    bytes: number
    /** `now()` at the last time this URL was returned to a caller. */
    lastHandout: number
}

export function createAssetUrlCache(options: AssetUrlCacheOptions): AssetUrlCache {
    const { maxBytes, graceMs, load } = options
    const createObjectURL = options.createObjectURL ?? ((blob: Blob) => URL.createObjectURL(blob))
    const revokeObjectURL = options.revokeObjectURL ?? ((url: string) => { URL.revokeObjectURL(url) })
    const now = options.now ?? (() => Date.now())
    const schedule = options.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms) })
    const onError = options.onError ?? ((loc: string, error: unknown) => {
        console.error(`[assetUrlCache] ${loc}`, error)
    })
    const useServiceWorker = options.useServiceWorker ?? (() => false)
    const swFetch = options.swFetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args))

    /** Insertion order is the LRU order: front is least recently handed out. */
    const entries = new Map<string, CacheEntry>()
    const inFlight = new Map<string, Promise<string>>()
    const listeners = new Set<AssetUrlEvictionListener>()

    /** Registered service-worker locs. Holds no asset bytes, only markers. */
    const swRegistered = new Set<string>()
    const swInFlight = new Map<string, Promise<void>>()

    let residentBytes = 0
    let pendingRevokeBytes = 0
    let evictions = 0
    let revocations = 0
    /**
     * Assets invalidated while a read of them was already in flight. That read
     * must not install its result, or the invalidation would be silently undone
     * by bytes fetched before it happened. Bounded by the in-flight count: an
     * entry is added only when a load is outstanding and removed when it lands.
     */
    const invalidatedWhileLoading = new Set<string>()

    function announceEviction(loc: string, url: string) {
        for (const listener of [...listeners, ...globalEvictionListeners]) {
            try {
                listener(loc, url)
            } catch (error) {
                onError(loc, error)
            }
        }
    }

    /** Releases a URL once it has been in a consumer's hands for graceMs. */
    function scheduleRevoke(loc: string, url: string, size: number, lastHandout: number) {
        pendingRevokeBytes += size
        const delay = Math.max(0, lastHandout + graceMs - now())
        schedule(() => {
            try {
                revokeObjectURL(url)
            } catch (error) {
                onError(loc, error)
            }
            pendingRevokeBytes -= size
            revocations++
        }, delay)
    }

    /**
     * Unlinks an entry. After this returns the cache cannot produce this URL
     * again -- the map no longer holds it and the next read rebuilds -- which is
     * what makes the deferred revoke safe.
     */
    function evict(entry: CacheEntry) {
        entries.delete(entry.loc)
        residentBytes -= entry.bytes
        evictions++
        announceEviction(entry.loc, entry.url)
        scheduleRevoke(entry.loc, entry.url, entry.bytes, entry.lastHandout)
    }

    function enforceBudget() {
        while (residentBytes > maxBytes) {
            const oldest = entries.values().next().value
            if (!oldest) {
                return
            }
            evict(oldest)
        }
    }

    /** Moves an entry to the most-recently-used end and restarts its grace. */
    function touch(entry: CacheEntry): string {
        entry.lastHandout = now()
        entries.delete(entry.loc)
        entries.set(entry.loc, entry)
        return entry.url
    }

    async function loadIntoCache(loc: string): Promise<string> {
        const data = await load(loc)
        if (!data || data.byteLength === undefined) {
            // Absent is a real answer, and a distinct one from "failed to read".
            // Either way it must not be remembered: a later write of the same
            // path has to be readable without a reload of the app.
            throw new Error(`asset "${loc}" is not present in storage`)
        }

        // Copying into the Blob is what moves the bytes off the JS heap; the
        // Uint8Array is unreferenced from here on.
        const blob = new Blob([data as unknown as BlobPart], { type: mimeTypeFor(loc) })
        const url = createObjectURL(blob)

        if (invalidatedWhileLoading.delete(loc)) {
            // Invalidated while this read was in flight. The caller still gets a
            // working URL, but it is never installed, and it is released on the
            // same schedule an evicted one would be.
            scheduleRevoke(loc, url, blob.size, now())
            return url
        }

        const raced = entries.get(loc)
        if (raced) {
            // Another read installed this asset while we were awaiting. Keep one
            // URL per asset rather than leaking the loser.
            scheduleRevoke(loc, url, blob.size, now())
            return touch(raced)
        }

        const entry: CacheEntry = { loc, url, bytes: blob.size, lastHandout: now() }
        entries.set(loc, entry)
        residentBytes += entry.bytes
        // An asset larger than the whole budget is evicted here, immediately
        // after insertion. That is deliberate: the caller still receives a URL
        // that stays live for the grace window, and the bound still holds.
        enforceBudget()
        return url
    }

    async function getBlobSrc(loc: string): Promise<string> {
        const hit = entries.get(loc)
        if (hit) {
            return touch(hit)
        }

        const existing = inFlight.get(loc)
        if (existing) {
            return await existing
        }

        const pending = loadIntoCache(loc)
        inFlight.set(loc, pending)
        try {
            return await pending
        } finally {
            // Cleared on failure as well as success. The bug this replaces left
            // a permanent 'loading' marker behind after a failed read, and every
            // later read of that asset then waited on it forever.
            inFlight.delete(loc)
            // A load that threw before reaching the check above would otherwise
            // leave its marker behind and make the *next* read discard itself.
            invalidatedWhileLoading.delete(loc)
        }
    }

    async function registerWithServiceWorker(loc: string, encoded: string): Promise<void> {
        const checked = await swFetch(`/sw/check/${encoded}`)
        const able: boolean = (await checked.json()).able
        if (!able) {
            const data = await load(loc)
            if (!data || data.byteLength === undefined) {
                throw new Error(`asset "${loc}" is not present in storage`)
            }
            await swFetch(`/sw/register/${encoded}`, {
                method: 'POST',
                body: data as unknown as BodyInit,
            })
            // Let the service worker install the response before it is requested.
            await new Promise<void>((resolve) => { schedule(resolve, 10) })
        }
        swRegistered.add(loc)
    }

    async function getServiceWorkerSrc(loc: string): Promise<string> {
        const encoded = Buffer.from(loc, 'utf-8').toString('hex')
        const target = `/sw/img/${encoded}`
        if (swRegistered.has(loc)) {
            return target
        }

        let pending = swInFlight.get(loc)
        if (!pending) {
            pending = registerWithServiceWorker(loc, encoded)
            swInFlight.set(loc, pending)
            // Detach the bookkeeping from the caller's chain so a rejection is
            // reported once, by the caller, rather than also going unhandled.
            void pending.catch(() => {}).then(() => { swInFlight.delete(loc) })
        }
        await pending
        return target
    }

    async function getFileSrc(loc: string): Promise<string> {
        if (!loc) {
            return ''
        }
        try {
            return useServiceWorker() ? await getServiceWorkerSrc(loc) : await getBlobSrc(loc)
        } catch (error) {
            // The '' return is the contract every existing caller was written
            // against, so it stays; the failure is reported rather than lost.
            onError(loc, error)
            return ''
        }
    }

    function invalidate(loc: string) {
        if (inFlight.has(loc)) {
            invalidatedWhileLoading.add(loc)
        }
        swRegistered.delete(loc)
        const entry = entries.get(loc)
        if (entry) {
            evict(entry)
        }
    }

    function clear() {
        for (const loc of inFlight.keys()) {
            invalidatedWhileLoading.add(loc)
        }
        swRegistered.clear()
        for (const entry of [...entries.values()]) {
            evict(entry)
        }
    }

    return {
        getFileSrc,
        invalidate,
        clear,
        stats: () => ({
            residentBytes,
            pendingRevokeBytes,
            entries: entries.size,
            evictions,
            revocations,
        }),
        subscribeEviction(listener) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
    }
}
