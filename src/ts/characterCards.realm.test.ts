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

afterEach(() => vi.unstubAllGlobals())

describe('RisuRealm browse transport', () => {
    test('returns response-local cards and HTML without mutating its query', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            cards: [], additionalHTML: '<aside>temporary</aside>',
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)
        const query = { search: '', page: 0, nsfw: false, sort: 'recommended' }

        await expect(getRisuHub(query)).resolves.toEqual({ cards: [], additionalHTML: '<aside>temporary</aside>' })
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
            .resolves.toEqual({ cards: [], additionalHTML: '' })
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
        const card = (id: string) => ({
            name: 'Character', desc: null, download: 0, id, img: 'image-id', tags: [], viewScreen: '',
            haslore: 0, hasemotion: 0, hasasset: 0, license: null, type: null,
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
})
