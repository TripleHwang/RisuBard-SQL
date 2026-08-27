import type { hubType } from './characterCards'
import { readPersistentJson, writePersistentJson } from './storage/persistentKv'

export const DEFAULT_REALM_BROWSE_CACHE_KEY = 'cache/realm/default-browse.v1.json'
export const DEFAULT_REALM_BROWSE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_CARDS = 100
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_STRING_LENGTH = 8_192
const MAX_TAGS = 32
const MAX_TAG_LENGTH = 128

export type RealmBrowseQuery = {
    search: string
    page: number
    nsfw: boolean
    sort: string
}

type RealmDefaultBrowseCacheV1 = {
    version: 1
    fetchedAt: number
    cards: hubType[]
}

function boundedString(value: unknown, maxLength = MAX_STRING_LENGTH): string | null {
    return typeof value === 'string' && value.length <= maxLength ? value : null
}

function boundedBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null
}

function boundedNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalizeRealmBrowseCard(value: unknown): hubType | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const card = value as Record<string, unknown>
    // Project known metadata fields only; transport helpers such as image blobs never survive this boundary.
    const tags = Array.isArray(card.tags) && card.tags.length <= MAX_TAGS
        ? card.tags.map((tag) => boundedString(tag, MAX_TAG_LENGTH))
        : null
    if (!tags || tags.some((tag) => tag === null)) return null
    const name = boundedString(card.name)
    const desc = boundedString(card.desc)
    const download = boundedString(card.download)
    const id = boundedString(card.id)
    const img = boundedString(card.img)
    const license = boundedString(card.license)
    const type = boundedString(card.type)
    const viewScreen = card.viewScreen
    const hasLore = boundedBoolean(card.hasLore)
    const hasEmotion = boundedBoolean(card.hasEmotion)
    const hasAsset = boundedBoolean(card.hasAsset)
    const hot = boundedNumber(card.hot)
    if (!name || desc === null || download === null || !id || img === null || license === null || type === null
        || (viewScreen !== 'none' && viewScreen !== 'emotion' && viewScreen !== 'imggen')
        || hasLore === null || hasEmotion === null || hasAsset === null || hot === null) return null
    if (/^(?:data|blob):/i.test(img.trim())) return null

    const optionalString = (key: 'creator' | 'creatorName' | 'authorname' | 'original') => {
        const field = card[key]
        return field === undefined ? undefined : boundedString(field)
    }
    const creator = optionalString('creator')
    const creatorName = optionalString('creatorName')
    const authorname = optionalString('authorname')
    const original = optionalString('original')
    const hidden = card.hidden === undefined ? undefined : boundedBoolean(card.hidden)
    if (creator === null || creatorName === null || authorname === null || original === null || hidden === null) return null

    return {
        name, desc, download, id, img, tags: tags as string[], viewScreen,
        hasLore, hasEmotion, hasAsset, hot, license, type,
        ...(creator === undefined ? {} : { creator }),
        ...(creatorName === undefined ? {} : { creatorName }),
        ...(authorname === undefined ? {} : { authorname }),
        ...(original === undefined ? {} : { original }),
        ...(hidden === undefined ? {} : { hidden }),
    }
}

function normalizeCache(value: unknown): RealmDefaultBrowseCacheV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const entry = value as Record<string, unknown>
    if (entry.version !== 1 || !Number.isFinite(entry.fetchedAt) || !Array.isArray(entry.cards) || entry.cards.length > MAX_CARDS) return null
    const cards = entry.cards.map(normalizeRealmBrowseCard)
    if (cards.some((card) => card === null)) return null
    const normalized = { version: 1 as const, fetchedAt: entry.fetchedAt as number, cards: cards as hubType[] }
    return new TextEncoder().encode(JSON.stringify(normalized)).byteLength <= MAX_METADATA_BYTES ? normalized : null
}

export function isDefaultRealmBrowseQuery(query: RealmBrowseQuery): boolean {
    return query.search === '' && query.page === 0 && query.nsfw === false && query.sort === 'recommended'
}

export async function readDefaultRealmBrowseCache(now = Date.now()): Promise<hubType[] | null> {
    try {
        const cache = normalizeCache(await readPersistentJson<unknown>(DEFAULT_REALM_BROWSE_CACHE_KEY))
        if (!cache || cache.fetchedAt > now || now - cache.fetchedAt > DEFAULT_REALM_BROWSE_CACHE_MAX_AGE_MS) return null
        return cache.cards
    } catch {
        return null
    }
}

export async function writeDefaultRealmBrowseCache(cards: hubType[], fetchedAt = Date.now()): Promise<void> {
    const cache = normalizeCache({ version: 1, fetchedAt, cards: cards.slice(0, MAX_CARDS) })
    if (!cache) throw new Error('Invalid RisuRealm browse cache payload')
    await writePersistentJson(DEFAULT_REALM_BROWSE_CACHE_KEY, cache)
}
