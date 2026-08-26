import { describe, expect, it } from 'vitest'
import { getAssetUrl } from './assetUrl'

describe('getAssetUrl', () => {
  it('returns a direct same-origin Node thumbnail URL', () => {
    expect(getAssetUrl('assets/portrait.png', { variant: 'thumbnail', node: true })).toBe('/api/asset/6173736574732f706f7274726169742e706e67/thumb')
  })
  it('uses no object or data URL fallback', () => {
    expect(getAssetUrl('assets/portrait.png', { variant: 'thumbnail', node: false })).toBeNull()
    expect(getAssetUrl('assets/sound.mp3', { variant: 'thumbnail', node: true })).toBeNull()
  })
})
