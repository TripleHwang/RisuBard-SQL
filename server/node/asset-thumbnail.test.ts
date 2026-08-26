import { describe, expect, it } from 'vitest'

// Kept independent of Express boot so cache/security behaviour stays cheap to test.
const { createAssetThumbnailService, decodeCanonicalHexKey } = require('./asset-thumbnail.cjs')

describe('asset thumbnails', () => {
  it('rejects non-canonical hex keys and non-assets image paths', () => {
    expect(() => decodeCanonicalHexKey('6162630')).toThrow()
    expect(() => decodeCanonicalHexKey('zz')).toThrow()
    expect(() => decodeCanonicalHexKey('6173736574732f2e2e2f7365637265742e706e67')).toThrow()
  })

  it('returns 304 from metadata without reading or inspecting the source', async () => {
    let reads = 0, inspections = 0
    const metadata = { object: 'a'.repeat(64), updatedAt: 17, size: 5 }
    const service = createAssetThumbnailService({
      getMetadata: () => metadata,
      get: () => { reads++; return Buffer.from('image') },
      inspect: async () => { inspections++; return { width: 1, height: 1 } },
      transform: async () => Buffer.from('webp'),
    })
    const first = await service.get('assets/portrait.png')
    const result = await service.get('assets/portrait.png', first.etag)
    expect(result.status).toBe(304)
    expect(reads).toBe(1)
    expect(inspections).toBe(1)
  })

  it('deduplicates concurrent transforms and bounds the cache', async () => {
    let transforms = 0
    const service = createAssetThumbnailService({
      getUpdatedAt: (key: string) => key === 'assets/a.png' ? 1 : 2,
      get: () => Buffer.from('image'),
      transform: async () => { transforms++; await Promise.resolve(); return Buffer.alloc(8) },
      maxEntries: 1,
      maxBytes: 8,
    })
    await Promise.all([service.get('assets/a.png'), service.get('assets/a.png')])
    expect(transforms).toBe(1)
    await service.get('assets/b.png')
    expect(service.stats().entries).toBe(1)
    expect(service.stats().bytes).toBe(8)
  })

  it('rejects corrupt, oversized, and pixel-bomb source data', async () => {
    const service = createAssetThumbnailService({
      getUpdatedAt: () => 1,
      get: () => Buffer.alloc(20),
      transform: async () => Buffer.from('webp'),
      maxSourceBytes: 10,
    })
    await expect(service.get('assets/a.png')).rejects.toMatchObject({ status: 422 })
  })

  it('changes ETag and regenerates when content changes at the same timestamp', async () => {
    let source = Buffer.from('first')
    let metadata = { object: 'a'.repeat(64), updatedAt: 1, size: 5 }
    let transforms = 0
    const service = createAssetThumbnailService({ getMetadata: () => metadata, get: () => source, transform: async () => Buffer.from(`webp-${++transforms}`) })
    const first = await service.get('assets/a.png')
    source = Buffer.from('other')
    metadata = { object: 'b'.repeat(64), updatedAt: 1, size: 5 }
    const second = await service.get('assets/a.png', first.etag)
    expect(second.status).toBe(200)
    expect(second.etag).not.toBe(first.etag)
    expect(transforms).toBe(2)
  })

  it('includes transform version in ETag and cache identity', async () => {
    const options = { getUpdatedAt: () => 1, get: () => Buffer.from('image'), transform: async () => Buffer.from('webp') }
    const first = await createAssetThumbnailService({ ...options, transformVersion: 'one' }).get('assets/a.png')
    const second = await createAssetThumbnailService({ ...options, transformVersion: 'two' }).get('assets/a.png', first.etag)
    expect(second.status).toBe(200)
    expect(second.etag).not.toBe(first.etag)
  })

  it('changes ETag when quality or max side changes', async () => {
    const options = { getMetadata: () => ({ object: 'a'.repeat(64), updatedAt: 1, size: 5 }), get: () => Buffer.from('image'), transform: async () => Buffer.from('webp') }
    const q75 = await createAssetThumbnailService({ ...options, quality: 75, maxSide: 320 }).get('assets/a.png')
    expect((await createAssetThumbnailService({ ...options, quality: 60, maxSide: 320 }).get('assets/a.png', q75.etag)).status).toBe(200)
    expect((await createAssetThumbnailService({ ...options, quality: 75, maxSide: 160 }).get('assets/a.png', q75.etag)).status).toBe(200)
  })

  it('shares source get and inspection across identical concurrent requests', async () => {
    let reads = 0, inspections = 0
    const service = createAssetThumbnailService({
      getUpdatedAt: () => 1, get: () => { reads++; return Buffer.from('image') },
      inspect: async () => { inspections++; await Promise.resolve(); return { width: 1, height: 1 } }, transform: async () => Buffer.from('webp'),
    })
    await Promise.all([service.get('assets/a.png'), service.get('assets/a.png')])
    expect(reads).toBe(1); expect(inspections).toBe(1)
  })

  it('caps distinct asset work at two concurrent operations', async () => {
    let active = 0, peak = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => release = resolve)
    const service = createAssetThumbnailService({
      getUpdatedAt: () => 1, get: () => Buffer.from('image'),
      inspect: async () => { active++; peak = Math.max(peak, active); await gate; active--; return { width: 1, height: 1 } },
      transform: async () => Buffer.from('webp'), maxConcurrent: 2,
    })
    const requests = ['a', 'b', 'c'].map((name) => service.get(`assets/${name}.png`))
    await Promise.resolve(); await Promise.resolve()
    expect(peak).toBe(2)
    release(); await Promise.all(requests)
  })

  it('rejects decoded pixel bombs under the source byte limit', async () => {
    const service = createAssetThumbnailService({
      getUpdatedAt: () => 1, get: () => Buffer.alloc(8), maxSourceBytes: 10, maxPixels: 4,
      inspect: async () => ({ width: 3, height: 3 }), transform: async () => Buffer.from('webp'),
    })
    await expect(service.get('assets/a.png')).rejects.toMatchObject({ status: 422 })
  })
})
