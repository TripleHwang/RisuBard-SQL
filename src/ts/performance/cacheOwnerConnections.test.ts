import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('production cache owners', () => {
    it('exports safe parser reclamation without revoking direct asset URLs', () => {
        const parser = source('src/ts/parser/parser.svelte.ts')
        expect(parser).toContain('export function clearParserRuntimeCaches')
        expect(parser).toContain('fileSrcCache.clear()')
        expect(parser).toContain('blobUrlCache.clear()')
        expect(parser).not.toContain('URL.revokeObjectURL')
    })

    it('exports inlay LRU reclamation and registers both owners at startup', () => {
        const inlays = source('src/ts/process/files/inlays.ts')
        const bootstrap = source('src/ts/bootstrap.ts')
        expect(inlays).toContain('export function clearInlayRuntimeCache')
        expect(inlays).toContain('totalLRUSize = 0')
        expect(bootstrap).toContain('registerRuntimeCacheOwners')
        expect(bootstrap).toContain('clearParserRuntimeCaches')
        expect(bootstrap).toContain('clearInlayRuntimeCache')
    })
})
