import { describe, expect, test, vi } from 'vitest'

vi.mock('./characterCards', () => ({}))
vi.mock('./storage/persistentKv', () => ({
    readPersistentJson: vi.fn(),
    writePersistentJson: vi.fn(),
}))

import { createRealmBrowseRequestCoordinator } from './realmBrowseRequest'

const defaultQuery = { search: '', page: 0, nsfw: false, sort: 'recommended' }

describe('RisuRealm browse request coordinator', () => {
    test('replaces a cached default display after a successful refresh', async () => {
        const fetcher = vi.fn().mockResolvedValue({ cards: ['fresh'], additionalHTML: '<p>fresh</p>' })
        const cache = vi.fn().mockResolvedValue(undefined)
        const updates: unknown[] = []
        const coordinator = createRealmBrowseRequestCoordinator(fetcher, cache)

        await coordinator.run(defaultQuery, { success: (result) => updates.push(result), failure: vi.fn() })

        expect(updates).toEqual([{ cards: ['fresh'], additionalHTML: '<p>fresh</p>' }])
        expect(cache).toHaveBeenCalledWith(['fresh'])
    })

    test('preserves stale cached cards by reporting a refresh failure without a replacement', async () => {
        const failure = new Error('offline')
        const coordinator = createRealmBrowseRequestCoordinator(vi.fn().mockRejectedValue(failure), vi.fn())
        const success = vi.fn()
        const onFailure = vi.fn()

        await coordinator.run(defaultQuery, { success, failure: onFailure })

        expect(success).not.toHaveBeenCalled()
        expect(onFailure).toHaveBeenCalledWith(failure)
    })

    test('aborts and ignores an obsolete default refresh when a newer search wins', async () => {
        let resolveDefault!: (value: { cards: string[]; additionalHTML: string }) => void
        const fetcher = vi.fn<(query: { search: string }, options?: { signal?: AbortSignal }) => Promise<{ cards: string[]; additionalHTML: string }>>((query) => query.search
            ? Promise.resolve({ cards: ['search'], additionalHTML: '<p>search</p>' })
            : new Promise((resolve) => { resolveDefault = resolve }))
        const cache = vi.fn().mockResolvedValue(undefined)
        const coordinator = createRealmBrowseRequestCoordinator(fetcher, cache)
        const shown: string[] = []
        const first = coordinator.run(defaultQuery, { success: (result) => shown.push(result.cards[0]), failure: vi.fn() })
        const second = coordinator.run({ ...defaultQuery, search: 'cats' }, { success: (result) => shown.push(result.cards[0]), failure: vi.fn() })

        await second
        resolveDefault({ cards: ['late-default'], additionalHTML: '<p>late</p>' })
        await first

        expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
        expect(shown).toEqual(['search'])
        expect(cache).not.toHaveBeenCalled()
    })

    test('serializes default cache writes so a delayed older write cannot finish after a newer feed', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce({ cards: ['A'], additionalHTML: '' })
            .mockResolvedValueOnce({ cards: ['B'], additionalHTML: '' })
        let releaseA!: () => void
        const persisted: string[] = []
        const cache = vi.fn((cards: string[]) => {
            persisted.push(cards[0])
            return cards[0] === 'A' ? new Promise<void>((resolve) => { releaseA = resolve }) : Promise.resolve()
        })
        const coordinator = createRealmBrowseRequestCoordinator(fetcher, cache)

        await coordinator.run(defaultQuery, { success: vi.fn(), failure: vi.fn() })
        await coordinator.run(defaultQuery, { success: vi.fn(), failure: vi.fn() })
        expect(persisted).toEqual(['A'])
        releaseA()
        await vi.waitFor(() => expect(persisted).toEqual(['A', 'B']))
    })

    test('does not let a late startup cache replace a user search or abort that search', async () => {
        type Result = { cards: string[]; additionalHTML: string }
        let resolveCache!: (cards: string[] | null) => void
        let resolveSearch!: (result: Result) => void
        const fetcher = vi.fn<(query: { search: string }, options?: { signal?: AbortSignal }) => Promise<Result>>((query) => query.search
            ? new Promise<Result>((resolve) => { resolveSearch = resolve })
            : new Promise<Result>(() => {}))
        const coordinator = createRealmBrowseRequestCoordinator(fetcher, vi.fn())
        const shown: string[] = []
        coordinator.applyInitialDefaultCache(new Promise<string[] | null>((resolve) => { resolveCache = resolve }), (cards) => shown.push(...cards))
        void coordinator.run(defaultQuery, { success: vi.fn(), failure: vi.fn() })
        const search = coordinator.run({ ...defaultQuery, search: 'cats' }, { success: (result) => shown.push(...result.cards), failure: vi.fn() })

        resolveCache(['cached'])
        resolveSearch({ cards: ['search'], additionalHTML: '' })
        await search

        expect(shown).toEqual(['search'])
        expect(fetcher).toHaveBeenCalledTimes(2)
        expect(fetcher.mock.calls[1][1]?.signal?.aborted).toBe(false)
    })
})
