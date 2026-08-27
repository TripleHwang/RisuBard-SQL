import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = () => readFileSync('src/ts/globalApi.svelte.ts', 'utf8')

// getUncleanables() decides which `assets/` KV keys survive cleanChunks()'s
// orphan sweep. It used to collect global db.personas[].icon but not
// character.personas[].icon, so a character-scoped persona's icon (when it
// shared no content hash with anything else) looked orphaned and was
// permanently deleted. Both getUncleanables() here and the server's
// buildUncleanableSet() now delegate the actual persona walk to
// server/node/assetOwnership.cjs so the two rule sets cannot drift apart again;
// see server/node/assetOwnership.test.ts for behavioral coverage of that walk.
//
// globalApi.svelte.ts pulls in browser/Svelte runtime globals at import
// time, so (matching this repo's existing convention -- see
// globalApiAssetLoading.test.ts) this is a source-shape check rather than an
// executed unit test.
describe('getUncleanables persona asset ownership', () => {
    test('uses the shared asset-ownership walk instead of a local persona loop', () => {
        const api = source()
        expect(api).toContain("from \"../../server/node/assetOwnership.cjs\"")
        expect(api).toContain('collectPersonaAssetRefs')
        expect(api).toContain('isAssetKeyValue')
    })

    test('walks character-scoped personas inside the per-character loop', () => {
        const api = source()
        const loopStart = api.indexOf('for (const cha of db.characters)')
        const loopEnd = api.indexOf('\n    }', loopStart)
        expect(loopStart).toBeGreaterThan(-1)
        const loopBody = api.slice(loopStart, loopEnd)
        expect(loopBody).toContain('collectPersonaAssetRefs(cha.personas, addUncleanable)')
    })

    test('still walks the global persona list', () => {
        const api = source()
        expect(api).toContain('collectPersonaAssetRefs(db.personas, addUncleanable)')
    })

    test('addUncleanable rejects empty/http(s)/data-URL values via the shared guard', () => {
        const api = source()
        const fnStart = api.indexOf('function addUncleanable(data: string)')
        const fnEnd = api.indexOf('\n    }', fnStart)
        expect(fnStart).toBeGreaterThan(-1)
        expect(api.slice(fnStart, fnEnd)).toContain('isAssetKeyValue(data)')
    })
})
