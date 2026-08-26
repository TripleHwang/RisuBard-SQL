import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve('src/lib/Mobile/MobileCharacters.svelte'), 'utf8')

it('uses a fixed-height virtual list with stable character identity', () => {
  expect(source).toContain('VirtualCharacterList count={characters.length} rowHeight={68} overscan={8}')
  expect(source).toContain('chaId: c.chaId')
  expect(source).toContain('getKey={(index) => characters[index].chaId}')
  expect(source).toContain('h-[68px]')
})

it('loads Node thumbnails lazily and falls back to the original URL', () => {
  expect(source).toContain("variant: 'thumbnail'")
  expect(source).toContain('loading="lazy" decoding="async"')
  expect(source).toContain("variant: 'full'")
})
