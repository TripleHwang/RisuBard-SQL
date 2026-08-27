import { beforeEach, describe, expect, test, vi } from 'vitest'

const persistent = vi.hoisted(() => ({
    readPersistentJson: vi.fn(),
    writePersistentJson: vi.fn(),
}))

vi.mock('./storage/persistentKv', () => persistent)

import {
    DEFAULT_REALM_BROWSE_CACHE_KEY,
    isDefaultRealmBrowseQuery,
    readDefaultRealmBrowseCache,
    writeDefaultRealmBrowseCache,
} from './realmBrowseCache'

const now = 1_700_000_000_000

function card(overrides: Record<string, unknown> = {}) {
    return {
        name: 'Cached character',
        desc: 'A safe cached description',
        download: '12',
        id: 'cached-id',
        img: 'cached-image',
        tags: ['safe'],
        viewScreen: 'none',
        hasLore: false,
        hasEmotion: false,
        hasAsset: false,
        hot: 1,
        license: 'CC-BY',
        type: 'character',
        ...overrides,
    }
}

describe('RisuRealm default browse cache', () => {
    beforeEach(() => {
        vi.resetAllMocks()
    })

    test('accepts only the exact public default query', () => {
        const query = { search: '', page: 0, nsfw: false, sort: 'recommended' }
        expect(isDefaultRealmBrowseQuery(query)).toBe(true)
        expect(isDefaultRealmBrowseQuery({ ...query, search: 'private term' })).toBe(false)
        expect(isDefaultRealmBrowseQuery({ ...query, page: 1 })).toBe(false)
        expect(isDefaultRealmBrowseQuery({ ...query, nsfw: true })).toBe(false)
        expect(isDefaultRealmBrowseQuery({ ...query, sort: '' })).toBe(false)
    })

    test('reads fresh valid cards but rejects expired, malformed, and oversized entries', async () => {
        persistent.readPersistentJson.mockResolvedValue({ version: 1, fetchedAt: now, cards: [card()] })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toEqual([card()])

        persistent.readPersistentJson.mockResolvedValue({ version: 1, fetchedAt: now - 24 * 60 * 60 * 1000 - 1, cards: [card()] })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toBeNull()

        persistent.readPersistentJson.mockResolvedValue({ version: 2, fetchedAt: now, cards: [card()] })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toBeNull()

        persistent.readPersistentJson.mockResolvedValue({ version: 1, fetchedAt: now, cards: Array.from({ length: 101 }, () => card()) })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toBeNull()

        persistent.readPersistentJson.mockResolvedValue({ version: 1, fetchedAt: now, cards: [card({ img: 'x'.repeat(1_100_000) })] })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toBeNull()

        persistent.readPersistentJson.mockResolvedValue({ version: 1, fetchedAt: now, cards: [card({ imageData: 'base64-image-bytes' })] })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toBeNull()
    })

    test('writes a bounded successful feed including a legitimate empty result', async () => {
        await writeDefaultRealmBrowseCache([], now)

        expect(persistent.writePersistentJson).toHaveBeenCalledWith(DEFAULT_REALM_BROWSE_CACHE_KEY, {
            version: 1,
            fetchedAt: now,
            cards: [],
        })
    })
})
