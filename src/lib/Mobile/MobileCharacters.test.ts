import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = readFileSync(resolve('src/lib/Mobile/MobileCharacters.svelte'), 'utf8')

it('uses a fixed-height virtual list with stable character identity', () => {
  expect(source).toContain('VirtualCharacterList count={characters.length} itemsSignature=')
  expect(source).toContain('chaId: c.chaId')
  expect(source).toContain('getKey={(index) => characters[index].chaId}')
  expect(source).toContain('data-virtual-index={index}')
  expect(source).toContain('tabindex={focusedIndex === index ? 0 : -1}')
  expect(source).toContain('itemsSignature={characters.map((char) => char.chaId).join')
  expect(source).toContain('h-[68px]')
})

it('loads Node thumbnails lazily and falls back to the original URL', () => {
  expect(source).toContain("variant: 'thumbnail'")
  expect(source).toContain('loading="lazy" decoding="async"')
  expect(source).toContain("variant: 'full'")
})

it('documents selected GridCatalog mode 3 as the only virtualized catalog mode', () => {
  const grid = readFileSync(resolve('src/lib/Others/GridCatalog.svelte'), 'utf8')
  expect(grid).toContain('Task 7 scope: only Simple (selected === 3)')
})
