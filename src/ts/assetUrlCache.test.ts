import { describe, expect, test, vi } from 'vitest'
import { createAssetUrlCache, type AssetUrlCache, type AssetUrlCacheOptions } from './assetUrlCache'

const KIB = 1024
const MIB = 1024 * 1024

/**
 * A ledger over object-URL creation/revocation. `liveBytes` is the number of
 * bytes the browser is still holding on the cache's behalf: every URL that has
 * been created and not yet revoked. That is the quantity the byte bound is
 * about, so the bound is measured here rather than asserted from the cache's
 * own bookkeeping.
 */
function createUrlLedger() {
    let counter = 0
    let liveBytes = 0
    const sizeOf = new Map<string, number>()
    const revoked = new Set<string>()
    const created: string[] = []

    return {
        get liveBytes() { return liveBytes },
        get revoked() { return revoked },
        get created() { return created },
        isLive(url: string) { return sizeOf.has(url) && !revoked.has(url) },
        createObjectURL(blob: Blob) {
            const url = `blob:risu-test/${++counter}`
            sizeOf.set(url, blob.size)
            liveBytes += blob.size
            created.push(url)
            return url
        },
        revokeObjectURL(url: string) {
            if (revoked.has(url)) {
                throw new Error(`double revoke of ${url}`)
            }
            const size = sizeOf.get(url)
            if (size === undefined) {
                throw new Error(`revoke of a URL this cache never created: ${url}`)
            }
            revoked.add(url)
            liveBytes -= size
        },
    }
}

/** Virtual clock so grace windows are exercised deterministically. */
function createClock() {
    let nowMs = 1_000
    let seq = 0
    let pending: { at: number, order: number, fn: () => void }[] = []
    return {
        now: () => nowMs,
        schedule(fn: () => void, ms: number) {
            pending.push({ at: nowMs + Math.max(0, ms), order: seq++, fn })
        },
        get pendingCount() { return pending.length },
        advance(ms: number) {
            nowMs += ms
            for (;;) {
                const due = pending.filter((task) => task.at <= nowMs).sort((a, b) => a.at - b.at || a.order - b.order)
                if (due.length === 0) return
                pending = pending.filter((task) => task.at > nowMs)
                for (const task of due) task.fn()
            }
        },
    }
}

function bytes(size: number, fill: number) {
    return new Uint8Array(size).fill(fill)
}

interface Harness {
    cache: AssetUrlCache
    ledger: ReturnType<typeof createUrlLedger>
    clock: ReturnType<typeof createClock>
    storage: Map<string, Uint8Array>
    loads: string[]
    errors: { loc: string, error: unknown }[]
}

function makeHarness(overrides: Partial<AssetUrlCacheOptions> = {}): Harness {
    const ledger = createUrlLedger()
    const clock = createClock()
    const storage = new Map<string, Uint8Array>()
    const loads: string[] = []
    const errors: { loc: string, error: unknown }[] = []

    const cache = createAssetUrlCache({
        maxBytes: MIB,
        graceMs: 60_000,
        load: async (loc) => {
            loads.push(loc)
            return storage.get(loc) ?? null
        },
        createObjectURL: (blob) => ledger.createObjectURL(blob),
        revokeObjectURL: (url) => ledger.revokeObjectURL(url),
        now: clock.now,
        schedule: clock.schedule,
        onError: (loc, error) => { errors.push({ loc, error }) },
        ...overrides,
    })

    return { cache, ledger, clock, storage, loads, errors }
}

/**
 * Guards against a hang. The cache's own waiting runs on the virtual clock, so
 * a promise that only the virtual clock could settle never settles here; this
 * turns "waits forever" into a failed assertion instead of a suite timeout.
 */
function withDeadline<T>(promise: Promise<T>, label: string, ms = 2_000): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms)
        }),
    ])
}

describe('asset URL cache: the byte bound', () => {
    test('holds at most maxBytes of live blob data across a working set that exceeds it', async () => {
        const { cache, ledger, clock, storage } = makeHarness({ maxBytes: MIB, graceMs: 60_000 })

        // Eight 256 KiB assets against a 1 MiB budget: the working set is 2 MiB,
        // exactly twice what the cache is allowed to hold.
        for (let i = 0; i < 8; i++) {
            storage.set(`assets/${i}.png`, bytes(256 * KIB, i))
        }

        const handed: string[] = []
        for (let i = 0; i < 8; i++) {
            const url = await cache.getFileSrc(`assets/${i}.png`)
            // Whatever came back has to be usable at the moment it is returned.
            expect(url).not.toBe('')
            expect(ledger.revoked.has(url)).toBe(false)
            handed.push(url)
            // Let each hand-out age past the grace window before the next load,
            // so nothing is protected and the bound must hold on its own.
            clock.advance(60_001)
        }

        // The bound itself, measured two ways: what the cache thinks it holds,
        // and what the browser is still holding on its behalf.
        expect(cache.stats().residentBytes).toBeLessThanOrEqual(MIB)
        expect(ledger.liveBytes).toBeLessThanOrEqual(MIB)

        for (const url of handed) {
            expect(url).toMatch(/^blob:/)
        }

        // Least-recently-used first: the four oldest are gone, the four newest stay.
        for (let i = 0; i < 4; i++) {
            expect(ledger.revoked.has(handed[i])).toBe(true)
        }
        for (let i = 4; i < 8; i++) {
            expect(ledger.revoked.has(handed[i])).toBe(false)
        }
    })

    test('a single asset larger than the whole budget is still served, then released', async () => {
        const { cache, ledger, clock, storage } = makeHarness({ maxBytes: 512 * KIB, graceMs: 60_000 })
        storage.set('assets/huge.png', bytes(2 * MIB, 7))

        const url = await cache.getFileSrc('assets/huge.png')
        expect(url).toMatch(/^blob:/)
        expect(ledger.isLive(url)).toBe(true)

        clock.advance(60_001)
        expect(ledger.revoked.has(url)).toBe(true)
        expect(ledger.liveBytes).toBe(0)
    })

    test('repeated reads of one asset neither re-load nor re-allocate', async () => {
        const { cache, ledger, loads, storage } = makeHarness()
        storage.set('assets/a.png', bytes(64 * KIB, 1))

        const first = await cache.getFileSrc('assets/a.png')
        const second = await cache.getFileSrc('assets/a.png')

        expect(second).toBe(first)
        expect(loads).toEqual(['assets/a.png'])
        expect(ledger.created).toHaveLength(1)
    })
})

describe('asset URL cache: eviction is safe for whoever still holds a URL', () => {
    test('a URL is never returned after it has been revoked', async () => {
        const { cache, ledger, clock, storage } = makeHarness({ maxBytes: 512 * KIB, graceMs: 60_000 })
        storage.set('assets/a.png', bytes(256 * KIB, 1))
        storage.set('assets/b.png', bytes(256 * KIB, 2))
        storage.set('assets/c.png', bytes(256 * KIB, 3))

        const seen: string[] = []
        const order = ['a', 'b', 'c', 'a', 'b', 'c', 'a']
        for (const name of order) {
            const url = await cache.getFileSrc(`assets/${name}.png`)
            // The invariant under test: whatever comes back is a URL that has
            // not been revoked.
            expect(ledger.revoked.has(url)).toBe(false)
            expect(ledger.isLive(url)).toBe(true)
            seen.push(url)
            clock.advance(60_001)
        }

        // 'a' was evicted and re-read, so it must have been rebuilt rather than
        // handed back as the same (by then revoked) string.
        expect(seen[3]).not.toBe(seen[0])
        expect(ledger.revoked.has(seen[0])).toBe(true)
    })

    test('a URL handed out moments ago is not revoked, even under budget pressure', async () => {
        const { cache, ledger, clock, storage } = makeHarness({ maxBytes: 512 * KIB, graceMs: 60_000 })
        for (let i = 0; i < 6; i++) {
            storage.set(`assets/${i}.png`, bytes(256 * KIB, i))
        }

        const handed: string[] = []
        for (let i = 0; i < 6; i++) {
            handed.push(await cache.getFileSrc(`assets/${i}.png`))
        }

        // Nothing has aged: every consumer that just received a URL can still
        // load from it, even though the cache is already over budget.
        for (const url of handed) {
            expect(ledger.isLive(url)).toBe(true)
        }
        expect(cache.stats().residentBytes).toBeLessThanOrEqual(512 * KIB)
        expect(cache.stats().pendingRevokeBytes).toBeGreaterThan(0)

        // Once the grace window passes, the deferred revocations run and the
        // live-byte total is back under the bound.
        clock.advance(60_001)
        expect(ledger.liveBytes).toBeLessThanOrEqual(512 * KIB)
        expect(cache.stats().pendingRevokeBytes).toBe(0)
    })

    test('eviction is announced so long-lived holders can drop their copy', async () => {
        const { cache, clock, storage } = makeHarness({ maxBytes: 512 * KIB, graceMs: 60_000 })
        storage.set('assets/a.png', bytes(256 * KIB, 1))
        storage.set('assets/b.png', bytes(256 * KIB, 2))
        storage.set('assets/c.png', bytes(256 * KIB, 3))

        const evicted: { loc: string, url: string }[] = []
        const unsubscribe = cache.subscribeEviction((loc, url) => { evicted.push({ loc, url }) })

        const a = await cache.getFileSrc('assets/a.png')
        clock.advance(60_001)
        await cache.getFileSrc('assets/b.png')
        clock.advance(60_001)
        await cache.getFileSrc('assets/c.png')

        expect(evicted).toEqual([{ loc: 'assets/a.png', url: a }])

        unsubscribe()
        clock.advance(60_001)
        await cache.getFileSrc('assets/a.png')
        expect(evicted).toHaveLength(1)
    })

    test('invalidate drops the entry and the next read rebuilds it', async () => {
        const { cache, ledger, clock, storage, loads } = makeHarness()
        storage.set('assets/a.png', bytes(64 * KIB, 1))

        const first = await cache.getFileSrc('assets/a.png')
        cache.invalidate('assets/a.png')

        const second = await cache.getFileSrc('assets/a.png')
        expect(second).not.toBe(first)
        expect(loads).toEqual(['assets/a.png', 'assets/a.png'])

        clock.advance(60_001)
        expect(ledger.revoked.has(first)).toBe(true)
        expect(ledger.revoked.has(second)).toBe(false)
    })

    test('a read already in flight when the asset is invalidated does not install its bytes', async () => {
        let releaseFirst: (data: Uint8Array) => void = () => {}
        const firstRead = new Promise<Uint8Array>((resolve) => { releaseFirst = resolve })
        let reads = 0

        const { cache, ledger, clock } = makeHarness({
            load: async () => {
                reads++
                return reads === 1 ? await firstRead : bytes(32 * KIB, 2)
            },
        })

        const pending = cache.getFileSrc('assets/a.png')
        // The bytes behind this path are replaced while the read is in flight.
        cache.invalidate('assets/a.png')
        releaseFirst(bytes(32 * KIB, 1))

        const stale = await withDeadline(pending, 'the read that was invalidated mid-flight')
        // The caller that asked still gets something it can load from...
        expect(stale).toMatch(/^blob:/)
        expect(ledger.isLive(stale)).toBe(true)
        // ...but the superseded bytes were not installed for anyone else.
        expect(cache.stats().entries).toBe(0)

        const fresh = await withDeadline(cache.getFileSrc('assets/a.png'), 'the read after invalidation')
        expect(reads).toBe(2)
        expect(fresh).not.toBe(stale)

        clock.advance(60_001)
        expect(ledger.revoked.has(stale)).toBe(true)
        expect(ledger.revoked.has(fresh)).toBe(false)
    })

    test('invalidating one asset leaves an unrelated in-flight read alone', async () => {
        let releaseA: (data: Uint8Array) => void = () => {}
        const readA = new Promise<Uint8Array>((resolve) => { releaseA = resolve })

        const { cache, storage } = makeHarness({
            load: async (loc: string) => (loc === 'assets/a.png' ? await readA : bytes(32 * KIB, 2)),
        })
        storage.set('assets/b.png', bytes(32 * KIB, 2))

        const pendingA = cache.getFileSrc('assets/a.png')
        cache.invalidate('assets/b.png')
        releaseA(bytes(32 * KIB, 1))

        const a = await withDeadline(pendingA, 'the unrelated in-flight read')
        expect(a).toMatch(/^blob:/)
        expect(cache.stats().entries).toBe(1)
        expect(await cache.getFileSrc('assets/a.png')).toBe(a)
    })

    test('clear releases everything it was holding', async () => {
        const { cache, ledger, clock, storage } = makeHarness()
        storage.set('assets/a.png', bytes(64 * KIB, 1))
        storage.set('assets/b.png', bytes(64 * KIB, 2))

        await cache.getFileSrc('assets/a.png')
        await cache.getFileSrc('assets/b.png')
        cache.clear()

        expect(cache.stats().residentBytes).toBe(0)
        expect(cache.stats().entries).toBe(0)

        clock.advance(60_001)
        expect(ledger.liveBytes).toBe(0)
    })
})

describe('asset URL cache: failures stay observable and do not poison the entry', () => {
    test('a failed read is reported, and a later read of the same asset succeeds', async () => {
        const { cache, storage, errors } = makeHarness({
            load: async (loc: string) => {
                if (!storage.has(loc)) throw new Error(`storage read failed for ${loc}`)
                return storage.get(loc)!
            },
        })

        const failed = await withDeadline(cache.getFileSrc('assets/a.png'), 'the failing read')
        expect(failed).toBe('')
        expect(errors).toHaveLength(1)
        expect(errors[0].loc).toBe('assets/a.png')
        expect((errors[0].error as Error).message).toContain('storage read failed')

        // The failure must not have left a permanent "loading" marker behind:
        // the retry has to actually run, and finish.
        storage.set('assets/a.png', bytes(16 * KIB, 1))
        const retried = await withDeadline(cache.getFileSrc('assets/a.png'), 'the retry after a failed read')
        expect(retried).toMatch(/^blob:/)
    })

    test('a missing asset is reported rather than cached as an empty result', async () => {
        const { cache, storage, errors } = makeHarness()

        const missing = await withDeadline(cache.getFileSrc('assets/gone.png'), 'the missing-asset read')
        expect(missing).toBe('')
        expect(errors).toHaveLength(1)

        storage.set('assets/gone.png', bytes(16 * KIB, 4))
        const found = await withDeadline(cache.getFileSrc('assets/gone.png'), 'the retry after a missing asset')
        expect(found).toMatch(/^blob:/)
    })

    test('concurrent readers of one asset share a single load and a single URL', async () => {
        const { cache, ledger, loads, storage } = makeHarness()
        storage.set('assets/a.png', bytes(32 * KIB, 9))

        const [first, second, third] = await withDeadline(
            Promise.all([
                cache.getFileSrc('assets/a.png'),
                cache.getFileSrc('assets/a.png'),
                cache.getFileSrc('assets/a.png'),
            ]),
            'three concurrent reads',
        )

        expect(loads).toEqual(['assets/a.png'])
        expect(ledger.created).toHaveLength(1)
        expect(second).toBe(first)
        expect(third).toBe(first)
    })

    test('a concurrent read that fails rejects every waiter observably and leaves no marker', async () => {
        const { cache, storage, errors } = makeHarness({
            load: async (loc: string) => {
                if (!storage.has(loc)) throw new Error(`storage read failed for ${loc}`)
                return storage.get(loc)!
            },
        })

        const results = await withDeadline(
            Promise.all([cache.getFileSrc('assets/a.png'), cache.getFileSrc('assets/a.png')]),
            'two concurrent failing reads',
        )
        expect(results).toEqual(['', ''])
        expect(errors.length).toBeGreaterThanOrEqual(1)

        storage.set('assets/a.png', bytes(16 * KIB, 1))
        const retried = await withDeadline(cache.getFileSrc('assets/a.png'), 'the retry after concurrent failures')
        expect(retried).toMatch(/^blob:/)
    })
})

describe('asset URL cache: service-worker mode', () => {
    /**
     * Service-worker mode allocates no blobs, so there is nothing here for the
     * virtual clock to gate; a real timer keeps the short post-register wait
     * honest without the test having to guess when it gets scheduled.
     */
    function swHarness(fetchImpl: typeof fetch) {
        const storage = new Map<string, Uint8Array>()
        const errors: { loc: string, error: unknown }[] = []
        const cache = createAssetUrlCache({
            maxBytes: MIB,
            graceMs: 60_000,
            load: async (loc) => storage.get(loc) ?? null,
            onError: (loc, error) => { errors.push({ loc, error }) },
            useServiceWorker: () => true,
            swFetch: fetchImpl,
        })
        return { cache, storage, errors }
    }

    test('registers an asset once and serves the service-worker URL thereafter', async () => {
        const calls: string[] = []
        const fetchImpl = vi.fn(async (input: any) => {
            const url = String(input)
            calls.push(url)
            if (url.startsWith('/sw/check/')) {
                return new Response(JSON.stringify({ able: false }))
            }
            return new Response('')
        }) as unknown as typeof fetch

        const { cache, storage } = swHarness(fetchImpl)
        storage.set('assets/a.png', bytes(16 * KIB, 1))

        const first = await withDeadline(cache.getFileSrc('assets/a.png'), 'the first service-worker read')

        const encoded = Buffer.from('assets/a.png', 'utf-8').toString('hex')
        expect(first).toBe(`/sw/img/${encoded}`)
        expect(calls).toEqual([`/sw/check/${encoded}`, `/sw/register/${encoded}`])

        const second = await withDeadline(cache.getFileSrc('assets/a.png'), 'the second service-worker read')
        expect(second).toBe(first)
        expect(calls).toHaveLength(2)
    })

    test('a failed registration is reported and can be retried', async () => {
        let failNext = true
        const fetchImpl = vi.fn(async (input: any) => {
            const url = String(input)
            if (url.startsWith('/sw/check/')) {
                if (failNext) {
                    failNext = false
                    throw new Error('service worker unreachable')
                }
                return new Response(JSON.stringify({ able: true }))
            }
            return new Response('')
        }) as unknown as typeof fetch

        const { cache, storage, errors } = swHarness(fetchImpl)
        storage.set('assets/a.png', bytes(16 * KIB, 1))

        const failed = await withDeadline(cache.getFileSrc('assets/a.png'), 'the failing service-worker read')
        expect(failed).toBe('')
        expect(errors).toHaveLength(1)
        expect((errors[0].error as Error).message).toContain('service worker unreachable')

        const retried = await withDeadline(cache.getFileSrc('assets/a.png'), 'the service-worker retry')
        expect(retried).toBe(`/sw/img/${Buffer.from('assets/a.png', 'utf-8').toString('hex')}`)
    })
})

describe('asset URL cache: against the real browser object-URL API', () => {
    test('hands out a real blob: URL and revokes it on eviction', async () => {
        const storage = new Map<string, Uint8Array>([
            ['assets/a.png', bytes(256 * KIB, 1)],
            ['assets/b.png', bytes(256 * KIB, 2)],
        ])
        const clock = createClock()
        const revoked: string[] = []
        const realRevoke = URL.revokeObjectURL.bind(URL)
        const cache = createAssetUrlCache({
            maxBytes: 256 * KIB,
            graceMs: 60_000,
            load: async (loc) => storage.get(loc) ?? null,
            revokeObjectURL: (url) => { revoked.push(url); realRevoke(url) },
            now: clock.now,
            schedule: clock.schedule,
            onError: () => {},
        })

        const a = await cache.getFileSrc('assets/a.png')
        expect(a.startsWith('blob:')).toBe(true)

        clock.advance(60_001)
        await cache.getFileSrc('assets/b.png')
        clock.advance(60_001)

        expect(revoked).toEqual([a])
    })
})
