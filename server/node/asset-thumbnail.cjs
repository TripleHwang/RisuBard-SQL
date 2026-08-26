const crypto = require('crypto')

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])
const TRANSFORM_VERSION = 'v1'

function httpError(status, message) {
    const error = new Error(message)
    error.status = status
    return error
}

function decodeCanonicalHexKey(hexKey) {
    if (typeof hexKey !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(hexKey)) throw httpError(400, 'Invalid asset key')
    const binary = Buffer.from(hexKey, 'hex')
    const key = binary.toString('utf8')
    if (Buffer.from(key, 'utf8').toString('hex') !== hexKey.toLowerCase()) throw httpError(400, 'Invalid asset key')
    if (!key.startsWith('assets/') || key.includes('..') || key.includes('\\') || !IMAGE_EXTENSIONS.has(key.split('.').pop().toLowerCase())) throw httpError(404, 'Asset not found')
    return key
}

function createAssetThumbnailService(options) {
    const maxEntries = options.maxEntries ?? 128
    const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    const maxSourceBytes = options.maxSourceBytes ?? 32 * 1024 * 1024
    const maxPixels = options.maxPixels ?? 40_000_000
    const cache = new Map()
    const inFlight = new Map()
    let bytes = 0

    const etag = updatedAt => `"thumb-${updatedAt}-${TRANSFORM_VERSION}"`
    const cacheKey = (key, updatedAt, source) => crypto.createHash('sha256').update(`${key}\0${updatedAt}\0${TRANSFORM_VERSION}\0`).update(source).digest('hex')
    const trim = () => {
        while (cache.size > maxEntries || bytes > maxBytes) {
            const first = cache.entries().next().value
            if (!first) break
            cache.delete(first[0]); bytes -= first[1].length
        }
    }

    async function get(key, ifNoneMatch) {
        if (!key.startsWith('assets/') || !IMAGE_EXTENSIONS.has(key.split('.').pop().toLowerCase())) throw httpError(404, 'Asset not found')
        const updatedAt = options.getUpdatedAt(key)
        if (updatedAt === null || updatedAt === undefined) throw httpError(404, 'Asset not found')
        const tag = etag(updatedAt)
        if (ifNoneMatch === tag) return { status: 304, etag: tag }

        const source = options.get(key)
        if (!source) throw httpError(404, 'Asset not found')
        if (source.length > maxSourceBytes) throw httpError(422, 'Image exceeds source byte limit')
        if (options.inspect) {
            const meta = await options.inspect(source)
            if (!meta || !Number.isFinite(meta.width) || !Number.isFinite(meta.height) || meta.width * meta.height > maxPixels) throw httpError(422, 'Image exceeds decoded pixel limit')
        }
        const id = cacheKey(key, updatedAt, source)
        let image = cache.get(id)
        if (image) {
            cache.delete(id); cache.set(id, image)
        } else {
            let operation = inFlight.get(id)
            if (!operation) {
                operation = Promise.resolve(options.transform(source)).then(result => {
                    const output = Buffer.from(result)
                    if (!output.length || output.length > maxBytes) throw httpError(422, 'Invalid thumbnail output')
                    cache.set(id, output); bytes += output.length; trim()
                    return output
                }).finally(() => inFlight.delete(id))
                inFlight.set(id, operation)
            }
            image = await operation
        }
        return { status: 200, etag: tag, image }
    }

    return { get, stats: () => ({ entries: cache.size, bytes }), clear: () => { cache.clear(); bytes = 0 } }
}

module.exports = { IMAGE_EXTENSIONS, TRANSFORM_VERSION, createAssetThumbnailService, decodeCanonicalHexKey, httpError }
