import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { hubType } from './characterCards'

const persistent = vi.hoisted(() => ({
    readPersistentJson: vi.fn(),
    writePersistentJson: vi.fn(),
}))

vi.mock('./storage/persistentKv', () => persistent)

import {
    DEFAULT_REALM_BROWSE_CACHE_KEY,
    isDefaultRealmBrowseQuery,
    normalizeRealmBrowseCard,
    readDefaultRealmBrowseCache,
    writeDefaultRealmBrowseCache,
} from './realmBrowseCache'

const now = 1_700_000_000_000

function card(overrides: Record<string, unknown> = {}): hubType {
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
        creator: '',
        creatorName: '',
        authorname: '',
        original: '',
        hidden: false,
        ...overrides,
    } as hubType
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

    test('normalizes the live RisuRealm card shape without retaining transport fields', () => {
        const liveCard = {
            name: 'Live character',
            desc: null,
            download: 12,
            id: 'live-id',
            img: 'resource/live-image',
            tags: ['live'],
            haslore: true,
            hasemotion: 0,
            hasasset: 1,
            hidden: 0,
            commentopen: null,
            viewScreen: '',
            creator: null,
            creatorName: null,
            authorname: null,
            original: null,
            license: null,
            type: null,
            unexpected: 'discard me',
        }

        expect(normalizeRealmBrowseCard(liveCard)).toEqual({
            name: 'Live character',
            desc: '',
            download: '12',
            id: 'live-id',
            img: 'resource/live-image',
            tags: ['live'],
            viewScreen: 'none',
            hasLore: true,
            hasEmotion: false,
            hasAsset: true,
            hot: 0,
            license: '',
            type: '',
            creator: '',
            creatorName: '',
            authorname: '',
            original: '',
            hidden: false,
        })
    })

    test('rejects unapproved scalar coercions', () => {
        for (const overrides of [
            { name: false },
            { id: 0 },
            { img: true },
            { tags: [1] },
            { license: false },
            { creator: false },
            { hasLore: '1' },
            { hidden: '0' },
        ]) {
            expect(normalizeRealmBrowseCard(card(overrides))).toBeNull()
        }
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
        await expect(readDefaultRealmBrowseCache(now)).resolves.toEqual([card()])
    })

    test('writes a bounded successful feed including a legitimate empty result', async () => {
        await writeDefaultRealmBrowseCache([], now)

        expect(persistent.writePersistentJson).toHaveBeenCalledWith(DEFAULT_REALM_BROWSE_CACHE_KEY, {
            version: 1,
            fetchedAt: now,
            cards: [],
        })
    })

    test('projects cache-safe metadata and caps a live feed at 100 cards', async () => {
        await writeDefaultRealmBrowseCache(Array.from({ length: 101 }, (_, index) => card({ id: `id-${index}`, imageData: 'discard-me', blob: 'discard-me' })), now)

        const written = persistent.writePersistentJson.mock.calls[0][1]
        expect(written.cards).toHaveLength(100)
        expect(written.cards[0]).not.toHaveProperty('imageData')
        expect(written.cards[0]).not.toHaveProperty('blob')
    })

    test('rejects inline image payload URLs but accepts a normal resource id', async () => {
        persistent.readPersistentJson.mockResolvedValue({ version: 1, fetchedAt: now, cards: [card({ img: '  DATA:image/png;base64,AAAA' })] })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toBeNull()

        persistent.readPersistentJson.mockResolvedValue({ version: 1, fetchedAt: now, cards: [card({ img: 'Blob:https://risu.example/asset' })] })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toBeNull()

        persistent.readPersistentJson.mockResolvedValue({ version: 1, fetchedAt: now, cards: [card({ img: 'resource/character-image' })] })
        await expect(readDefaultRealmBrowseCache(now)).resolves.toEqual([card({ img: 'resource/character-image' })])
    })
})
