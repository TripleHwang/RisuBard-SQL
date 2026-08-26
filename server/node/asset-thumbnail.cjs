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
    const maxConcurrent = options.maxConcurrent ?? 2
    const maxQueue = options.maxQueue ?? 32
    const transformVersion = options.transformVersion ?? TRANSFORM_VERSION
    const cache = new Map()
    const inFlight = new Map()
    let bytes = 0
    let active = 0
    const queue = []

    const runBounded = (operation) => new Promise((resolve, reject) => {
        const start = () => {
            active++
            Promise.resolve(operation()).then(resolve, reject).finally(() => {
                active--
                queue.shift()?.()
            })
        }
        if (active < maxConcurrent) return start()
        if (queue.length >= maxQueue) return reject(httpError(429, 'Thumbnail queue is full'))
        queue.push(start)
    })
    const getMetadata = options.getMetadata ?? (key => {
        const updatedAt = options.getUpdatedAt(key)
        return updatedAt === null || updatedAt === undefined ? null : { object: String(updatedAt), updatedAt, size: 0 }
    })
    const transformFingerprint = crypto.createHash('sha256').update(JSON.stringify({
        version: transformVersion,
        format: options.format ?? 'webp',
        maxSide: options.maxSide ?? 320,
        quality: options.quality ?? 75,
        formatParams: options.formatParams ?? {},
    })).digest('hex').slice(0, 16)
    const etag = hash => `"thumb-${transformFingerprint}-${hash}"`
    const cacheKey = (key, metadata) => crypto.createHash('sha256').update(`${key}\0${metadata.updatedAt}\0${transformFingerprint}\0${metadata.object}`).digest('hex')
    const trim = () => {
        while (cache.size > maxEntries || bytes > maxBytes) {
            const first = cache.entries().next().value
            if (!first) break
            cache.delete(first[0]); bytes -= first[1].length
        }
    }

    async function resolve(key, metadata) {
        const operationKey = `${key}\0${metadata.object}`
        let operation = inFlight.get(operationKey)
        if (operation) return operation
        operation = runBounded(async () => {
            const source = options.get(key)
            if (!source) throw httpError(404, 'Asset not found')
            if (source.length > maxSourceBytes) throw httpError(422, 'Image exceeds source byte limit')
            if (options.inspect) {
                const meta = await options.inspect(source)
                if (!meta || !Number.isFinite(meta.width) || !Number.isFinite(meta.height) || meta.width * meta.height > maxPixels) throw httpError(422, 'Image exceeds decoded pixel limit')
            }
            const id = cacheKey(key, metadata)
            let image = cache.get(id)
            if (image) {
                cache.delete(id); cache.set(id, image)
            } else {
                image = Buffer.from(await options.transform(source))
                if (!image.length || image.length > maxBytes) throw httpError(422, 'Invalid thumbnail output')
                cache.set(id, image); bytes += image.length; trim()
            }
            return { etag: etag(metadata.object), image }
        }).finally(() => inFlight.delete(operationKey))
        inFlight.set(operationKey, operation)
        return operation
    }

    async function get(key, ifNoneMatch) {
        if (!key.startsWith('assets/') || !IMAGE_EXTENSIONS.has(key.split('.').pop().toLowerCase())) throw httpError(404, 'Asset not found')
        const metadata = getMetadata(key)
        if (!metadata?.object || metadata.updatedAt === null || metadata.updatedAt === undefined) throw httpError(404, 'Asset not found')
        const tag = etag(metadata.object)
        if (ifNoneMatch === tag) return { status: 304, etag: tag }
        const result = await resolve(key, metadata)
        return { status: 200, etag: tag, image: result.image }
    }

    return { get, stats: () => ({ entries: cache.size, bytes }), clear: () => { cache.clear(); bytes = 0 } }
}

module.exports = { IMAGE_EXTENSIONS, TRANSFORM_VERSION, createAssetThumbnailService, decodeCanonicalHexKey, httpError }
