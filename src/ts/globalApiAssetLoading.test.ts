import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = () => readFileSync('src/ts/globalApi.svelte.ts', 'utf8')

describe('service-worker asset loading', () => {
    test('settles failed registrations instead of stranding later image rows in loading', () => {
        const api = source()
        expect(api).toContain("'failed'")
        expect(api).toContain("fileCache.res[ind] = 'failed'")
        expect(api).toContain("else if (fileCache.res[ind] === 'failed')")
        expect(api).toContain("fileCache.res[ind] = 'loading'")
        expect(api).toContain('Failed to read service-worker asset fallback')
    })

    test('detects a WebP payload instead of labelling every data URL as PNG', () => {
        const api = source()
        expect(api).toContain('function getAssetMimeType')
        expect(api).toContain("return 'image/webp'")
        expect(api).toContain('function getAssetDataUrl')
    })
})
