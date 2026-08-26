import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const moduleSource = () => readFileSync('src/ts/process/modules.ts', 'utf8')
const serverSource = () => readFileSync('server/node/server.cjs', 'utf8')

describe('module asset MIME preservation', () => {
    test('uses decoded bytes rather than a stale risum manifest extension for future imports', () => {
        const source = moduleSource()
        expect(source).toContain('function getAssetExtensionFromBytes')
        expect(source).toContain("return 'webp'")
        expect(source).toContain('getAssetExtensionFromBytes(data, module.assets[task.index][2])')
        expect(source).toContain('getAssetExtensionFromBytes(data, module.assets?.[task.index]?.[2])')
    })

    test('serves existing mismatched imported assets according to their bytes', () => {
        const source = serverSource()
        expect(source).toContain('const detectedType = detectMime(rawValue)')
        expect(source).toContain("detectedType !== 'application/octet-stream'")
    })
})
