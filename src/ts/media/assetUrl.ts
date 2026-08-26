import { Buffer } from 'buffer'

const THUMBNAIL_IMAGE = /\.(png|jpe?g|gif|webp)$/i

/** A browser-cacheable Node asset URL; callers retain their existing local fallback. */
export function getAssetUrl(path: string, options: { variant: 'full' | 'thumbnail'; node: boolean }): string | null {
    if (!options.node || !path || (options.variant === 'thumbnail' && !THUMBNAIL_IMAGE.test(path))) return null
    const base = `/api/asset/${Buffer.from(path, 'utf8').toString('hex')}`
    return options.variant === 'thumbnail' ? `${base}/thumb` : base
}
