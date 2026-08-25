import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

describe('API v3 inlay permission compatibility', () => {
    test('requires periodically reconfirmed permission before exposing an inlay', () => {
        const source = readFileSync('src/ts/plugins/apiV3/v3.svelte.ts', 'utf8')
        expect(source).toContain("|'inlay'")
        expect(source).toContain("getPluginPermission(plugin.name, 'inlay', 'periodically')")
        expect(source).toMatch(/if\s*\(!conf\)\s*\{\s*return null;/)
        expect(source).toContain('language.inlayPermissionConsent')
    })

    test('retains the legacy 2.1 adapter for installed plugin compatibility', () => {
        const source = readFileSync('src/ts/plugins/plugins.svelte.ts', 'utf8')
        expect(source).toContain("apiInternalVersion = '2.1'")
        expect(source).toContain('checkCodeSafety(jsFile)')
    })
})
