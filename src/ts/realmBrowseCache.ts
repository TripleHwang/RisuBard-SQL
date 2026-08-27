import type { hubType } from './characterCards'
import { readPersistentJson, writePersistentJson } from './storage/persistentKv'

export const DEFAULT_REALM_BROWSE_CACHE_KEY = 'cache/realm/default-browse.v1.json'
export const DEFAULT_REALM_BROWSE_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_CARDS = 100
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_STRING_LENGTH = 8_192
const MAX_TAGS = 32
const MAX_TAG_LENGTH = 128
// Only the first few rejections are reported: the log has to stay diagnosable without
// echoing an unbounded amount of remote content back into the console.
const MAX_REPORTED_REJECTIONS = 3

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

function boundedStringOrNumber(value: unknown): string | null {
    if (typeof value === 'string') return boundedString(value)
    if (typeof value === 'number' && Number.isFinite(value)) return boundedString(String(value))
    return null
}

function boundedBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') return value
    if (value === 1) return true
    if (value === 0) return false
    return null
}

function boundedNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Which check refused the card, plus its id when the id itself validated. Never card contents. */
export type RealmBrowseCardRejection = {
    field: string
    id: string | null
}

export type RealmBrowseCardInspection =
    | { card: hubType; rejection: null; degradedViewScreen: boolean }
    | { card: null; rejection: RealmBrowseCardRejection; degradedViewScreen: false }

export type RealmBrowseScreening = {
    cards: hubType[]
    /** Cards refused by the validator and left out of `cards`. */
    dropped: number
    /** Cards kept after replacing a viewScreen mode this client cannot render with 'none'. */
    degraded: number
    /** At most MAX_REPORTED_REJECTIONS entries, for logging. */
    reasons: RealmBrowseCardRejection[]
}

function refuse(field: string, id: string | null): RealmBrowseCardInspection {
    return { card: null, rejection: { field, id }, degradedViewScreen: false }
}

/**
 * Validate one untrusted RisuRealm card and report which check refused it.
 * The accept/refuse decision is identical to the previous normalizeRealmBrowseCard with one
 * deliberate exception: an unrecognized `viewScreen` degrades to 'none' instead of refusing the
 * card. viewScreen only names an optional preview mode, so an unknown mode means "this client
 * cannot render that preview", not "this payload is unsafe" — and the server is free to add modes.
 */
export function inspectRealmBrowseCard(value: unknown): RealmBrowseCardInspection {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('card', null)
    const card = value as Record<string, unknown>
    // Resolve the id first so every later rejection can name the offending card.
    const id = boundedString(card.id)
    // Project known metadata fields only; transport helpers such as image blobs never survive this boundary.
    const tags = Array.isArray(card.tags) && card.tags.length <= MAX_TAGS
        ? card.tags.map((tag) => boundedString(tag, MAX_TAG_LENGTH))
        : null
    if (!tags || tags.some((tag) => tag === null)) return refuse('tags', id)
    const name = boundedString(card.name)
    if (!name) return refuse('name', id)
    const desc = card.desc == null ? '' : boundedString(card.desc)
    if (desc === null) return refuse('desc', id)
    const download = card.download == null ? '' : boundedStringOrNumber(card.download)
    if (download === null) return refuse('download', id)
    if (!id) return refuse('id', null)
    const img = boundedString(card.img)
    if (img === null) return refuse('img', id)
    // Inline payload URLs are refused outright: an image the server can inline is content we would
    // hand straight to the renderer, and no legitimate browse card needs one.
    if (/^(?:data|blob):/i.test(img.trim())) return refuse('img', id)
    const license = card.license == null ? '' : boundedString(card.license)
    if (license === null) return refuse('license', id)
    const type = card.type == null ? '' : boundedString(card.type)
    if (type === null) return refuse('type', id)
    const requestedViewScreen = card.viewScreen
    const knownViewScreen: hubType['viewScreen'] | null =
        requestedViewScreen == null || requestedViewScreen === '' || requestedViewScreen === 'none' ? 'none'
        : requestedViewScreen === 'emotion' || requestedViewScreen === 'imggen' ? requestedViewScreen
        : null
    const viewScreen = knownViewScreen ?? 'none'
    const degradedViewScreen = knownViewScreen === null
    const hasLore = boundedBoolean(card.hasLore ?? card.haslore)
    if (hasLore === null) return refuse('hasLore', id)
    const hasEmotion = boundedBoolean(card.hasEmotion ?? card.hasemotion)
    if (hasEmotion === null) return refuse('hasEmotion', id)
    const hasAsset = boundedBoolean(card.hasAsset ?? card.hasasset)
    if (hasAsset === null) return refuse('hasAsset', id)
    const hot = card.hot == null ? 0 : boundedNumber(card.hot)
    if (hot === null) return refuse('hot', id)

    const optionalString = (key: 'creator' | 'creatorName' | 'authorname' | 'original') => {
        const field = card[key]
        return field == null ? '' : boundedString(field)
    }
    const creator = optionalString('creator')
    if (creator === null) return refuse('creator', id)
    const creatorName = optionalString('creatorName')
    if (creatorName === null) return refuse('creatorName', id)
    const authorname = optionalString('authorname')
    if (authorname === null) return refuse('authorname', id)
    const original = optionalString('original')
    if (original === null) return refuse('original', id)
    const hidden = card.hidden == null ? false : boundedBoolean(card.hidden)
    if (hidden === null) return refuse('hidden', id)

    return {
        card: {
            name, desc, download, id, img, tags: tags as string[], viewScreen,
            hasLore, hasEmotion, hasAsset, hot, license, type,
            creator, creatorName, authorname, original, hidden,
        },
        rejection: null,
        degradedViewScreen,
    }
}

export function normalizeRealmBrowseCard(value: unknown): hubType | null {
    return inspectRealmBrowseCard(value).card
}

/** Validate a list of untrusted cards, keeping the readable ones and counting the rest. */
export function screenRealmBrowseCards(values: readonly unknown[]): RealmBrowseScreening {
    const cards: hubType[] = []
    const reasons: RealmBrowseCardRejection[] = []
    let dropped = 0
    let degraded = 0
    for (const value of values) {
        const inspection = inspectRealmBrowseCard(value)
        if (!inspection.card) {
            dropped += 1
            if (reasons.length < MAX_REPORTED_REJECTIONS) reasons.push(inspection.rejection)
            continue
        }
        if (inspection.degradedViewScreen) degraded += 1
        cards.push(inspection.card)
    }
    return { cards, dropped, degraded, reasons }
}

export function describeRealmCardRejections(reasons: readonly RealmBrowseCardRejection[]): string {
    return reasons.map(({ field, id }) => id ? `${field} (id ${id})` : field).join(', ')
}

/** One line per browse, naming the failing fields only — never the card contents. */
export function reportRealmBrowseScreening(source: string, screening: RealmBrowseScreening): void {
    if (screening.dropped === 0 && screening.degraded === 0) return
    const details = [
        `kept ${screening.cards.length}`,
        `dropped ${screening.dropped}`,
        screening.degraded > 0 ? `unknown viewScreen on ${screening.degraded}` : '',
        screening.dropped > 0 ? `first failures: ${describeRealmCardRejections(screening.reasons)}` : '',
    ].filter(Boolean).join('; ')
    console.warn(`[RisuRealm] ${source}: ${details}`)
}

export class RealmBrowseUnreadableError extends Error {
    readonly realmBrowseUnreadable = true
    readonly dropped: number
    readonly reasons: RealmBrowseCardRejection[]
    constructor(screening: RealmBrowseScreening) {
        super(`RisuRealm response had no readable card (dropped ${screening.dropped}: ${describeRealmCardRejections(screening.reasons)})`)
        this.name = 'RealmBrowseUnreadableError'
        this.dropped = screening.dropped
        this.reasons = screening.reasons
    }
}

export function isRealmBrowseUnreadableError(error: unknown): error is RealmBrowseUnreadableError {
    return !!error && typeof error === 'object' && (error as { realmBrowseUnreadable?: unknown }).realmBrowseUnreadable === true
}

function normalizeCache(value: unknown, options: { tolerateUnreadableCards?: boolean } = {}): RealmDefaultBrowseCacheV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const entry = value as Record<string, unknown>
    if (entry.version !== 1 || !Number.isFinite(entry.fetchedAt) || !Array.isArray(entry.cards) || entry.cards.length > MAX_CARDS) return null
    const screening = screenRealmBrowseCards(entry.cards)
    // A cache entry is written by us, so an unreadable card in it is more suspicious than one from
    // the server: on read we keep the readable remainder rather than blanking the page, but a cache
    // whose every card is unreadable is treated as corrupt and discarded outright. The write path
    // stays strict — it only ever receives cards this same validator already accepted.
    if (screening.dropped > 0 && (!options.tolerateUnreadableCards || screening.cards.length === 0)) return null
    reportRealmBrowseScreening('default browse cache', screening)
    const normalized = { version: 1 as const, fetchedAt: entry.fetchedAt as number, cards: screening.cards }
    return new TextEncoder().encode(JSON.stringify(normalized)).byteLength <= MAX_METADATA_BYTES ? normalized : null
}

export function isDefaultRealmBrowseQuery(query: RealmBrowseQuery): boolean {
    return query.search === '' && query.page === 0 && query.nsfw === false && query.sort === 'recommended'
}

export async function readDefaultRealmBrowseCache(now = Date.now()): Promise<hubType[] | null> {
    try {
        const cache = normalizeCache(await readPersistentJson<unknown>(DEFAULT_REALM_BROWSE_CACHE_KEY), { tolerateUnreadableCards: true })
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
