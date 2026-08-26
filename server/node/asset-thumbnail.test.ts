import { describe, expect, it } from 'vitest'

// Kept independent of Express boot so cache/security behaviour stays cheap to test.
const { createAssetThumbnailService, decodeCanonicalHexKey } = require('./asset-thumbnail.cjs')

describe('asset thumbnails', () => {
  it('rejects non-canonical hex keys and non-assets image paths', () => {
    expect(() => decodeCanonicalHexKey('6162630')).toThrow()
    expect(() => decodeCanonicalHexKey('zz')).toThrow()
    expect(() => decodeCanonicalHexKey('6173736574732f2e2e2f7365637265742e706e67')).toThrow()
  })

  it('returns 304 before reading or transforming a matching source', async () => {
    let reads = 0
    const service = createAssetThumbnailService({
      getUpdatedAt: () => 17,
      get: () => { reads++; return Buffer.from('image') },
      transform: async () => Buffer.from('webp'),
    })
    const result = await service.get('assets/portrait.png', '"thumb-17-v1"')
    expect(result.status).toBe(304)
    expect(reads).toBe(0)
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
})
