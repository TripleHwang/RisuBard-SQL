import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('./process/modules', () => ({
    exportModuleLegacy: vi.fn(), readModule: vi.fn(),
}))
vi.mock('./stores.svelte', () => ({
    selectedCharID: { set: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    selIdState: { selId: undefined },
    DBState: { db: { characters: [] } },
}))

import { getRisuHub } from './characterCards'
import { isRealmBrowseUnreadableError } from './realmBrowseCache'

afterEach(() => vi.unstubAllGlobals())

function liveCard(id: string, overrides: Record<string, unknown> = {}) {
    return {
        name: 'Character', desc: null, download: 0, id, img: 'image-id', tags: [], viewScreen: '',
        haslore: 0, hasemotion: 0, hasasset: 0, license: null, type: null,
        ...overrides,
    }
}

describe('RisuRealm browse transport', () => {
    test('returns response-local cards and HTML without mutating its query', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            cards: [], additionalHTML: '<aside>temporary</aside>',
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const query = { search: '', page: 0, nsfw: false, sort: 'recommended' }

        await expect(getRisuHub(query)).resolves.toEqual({ cards: [], additionalHTML: '<aside>temporary</aside>', droppedCards: 0 })
        expect(query).toEqual({ search: '', page: 0, nsfw: false, sort: 'recommended' })
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: undefined })
    })

    test('passes cancellation through and rejects non-success responses instead of treating them as empty feeds', async () => {
        const controller = new AbortController()
        const fetchMock = vi.fn().mockResolvedValue(new Response('offline', { status: 503 }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' }, { signal: controller.signal })).rejects.toThrow('503')
        expect(fetchMock.mock.calls[0][1]).toMatchObject({ signal: controller.signal })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('retries one transient network failure and returns the recovered feed', async () => {
        const fetchMock = vi.fn()
            .mockRejectedValueOnce(new TypeError('temporary network failure'))
            .mockResolvedValueOnce(new Response(JSON.stringify({ cards: [] }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        await expect(getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' }))
            .resolves.toEqual({ cards: [], additionalHTML: '', droppedCards: 0 })
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('does not retry non-network exceptions', async () => {
        const fetchMock = vi.fn().mockRejectedValue(new Error('programming failure'))
        vi.stubGlobal('fetch', fetchMock)

        await expect(getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' }))
            .rejects.toThrow('programming failure')
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test('does not issue the retry when cancellation happens during backoff', async () => {
        const controller = new AbortController()
        const fetchMock = vi.fn().mockResolvedValue(new Response('offline', { status: 503 }))
        vi.stubGlobal('fetch', fetchMock)

        const request = getRisuHub(
            { search: '', page: 0, nsfw: false, sort: 'recommended' },
            { signal: controller.signal },
        )
        setTimeout(() => controller.abort(new Error('cancelled')), 10)

        await expect(request).rejects.toThrow('cancelled')
        expect(fetchMock).toHaveBeenCalledOnce()
    })

    test('projects a live response and caps it at 100 cards', async () => {
        const card = (id: string) => liveCard(id, {
            imageData: 'not persisted', blob: 'not persisted', additionalHTML: 'not card html',
        })
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ cards: Array.from({ length: 101 }, (_, index) => card(String(index))) }), { status: 200 })))

        const result = await getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' })
        expect(result.cards).toHaveLength(100)
        expect(result.cards[0]).not.toHaveProperty('imageData')
        expect(result.cards[0]).not.toHaveProperty('blob')
        expect(result.cards[0]).not.toHaveProperty('additionalHTML')
        expect(result.cards[0]).toMatchObject({ desc: '', download: '0', viewScreen: 'none', hot: 0, license: '', type: '' })
    })

    test('drops the single unreadable card and still renders the rest of the page', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        const cards: unknown[] = Array.from({ length: 5 }, (_, index) => liveCard(String(index)))
        cards[2] = liveCard('rejected', { tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`) })
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ cards }), { status: 200 })))

        const result = await getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' })

        expect(result.cards.map((card) => card.id)).toEqual(['0', '1', '3', '4'])
        expect(result.droppedCards).toBe(1)
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0][0]).toContain('dropped 1')
        expect(warn.mock.calls[0][0]).toContain('tags (id rejected)')
        warn.mockRestore()
    })

    test('degrades an unknown viewScreen mode instead of deleting the card from the feed', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            cards: [liveCard('future', { viewScreen: 'holodeck' })],
        }), { status: 200 })))

        const result = await getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' })

        expect(result.cards).toHaveLength(1)
        expect(result.cards[0]).toMatchObject({ id: 'future', viewScreen: 'none' })
        expect(result.droppedCards).toBe(0)
        expect(warn.mock.calls[0][0]).toContain('unknown viewScreen on 1')
        warn.mockRestore()
    })

    test('fails with the dropped count and reasons only when no card at all survived', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            cards: [liveCard('a', { name: '' }), liveCard('b', { img: 'data:image/png;base64,AAAA' }), 'not a card'],
        }), { status: 200 })))

        const error = await getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' }).catch((thrown) => thrown)
        expect(isRealmBrowseUnreadableError(error)).toBe(true)
        expect((error as Error).message).toBe('RisuRealm response had no readable card (dropped 3: name (id a), img (id b), card)')
        warn.mockRestore()
    })

    test('keeps a malformed response shape fatal and an empty feed successful', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ cards: 'nope' }), { status: 200 })))
        await expect(getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' }))
            .rejects.toThrow('RisuRealm response has an invalid card list')

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ cards: [] }), { status: 200 })))
        await expect(getRisuHub({ search: '', page: 0, nsfw: false, sort: 'recommended' }))
            .resolves.toMatchObject({ cards: [], droppedCards: 0 })
    })
})
