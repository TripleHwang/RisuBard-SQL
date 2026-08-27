import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = () => readFileSync('src/ts/bootstrap.ts', 'utf8')

// cleanChunks() permanently deletes any `assets/` KV key that
// getUncleanables() didn't collect. The Node/SQL lazy-loading backend can
// leave characters as metadata-only summaries (`detailsLoaded === false`)
// whose body -- including character.personas -- has not been fetched from
// SQL yet. getUncleanables() can only see what is actually attached to
// `db`, so if cleanChunks() ran while any character was still a stub, that
// character's (unseen) persona icons would look orphaned and be deleted for
// real, even after the character.personas fix in getUncleanables().
//
// The fix: skip the whole sweep -- do not delete anything -- while any
// character is metadata-only, reusing the same
// hasMetadataOnlyCharacters() guard plugins.svelte.ts already applies to
// plugin DB access for the identical "stub looks empty" hazard.
//
// bootstrap.ts pulls in browser/Svelte runtime globals at import time, so
// (matching this repo's existing convention -- see
// globalApiAssetLoading.test.ts) this is a source-shape check rather than an
// executed unit test.
describe('cleanChunks partial-hydration guard', () => {
    test('imports the existing metadata-only-character detector instead of re-deriving it', () => {
        const src = source()
        expect(src).toContain('hasMetadataOnlyCharacters')
        expect(src).toMatch(/import\s*{[^}]*hasMetadataOnlyCharacters[^}]*}\s*from\s*"\.\/plugins\/plugins\.svelte"/)
    })

    test('cleanChunks bails out before computing uncleanables when any character is still a stub', () => {
        const src = source()
        const fnStart = src.indexOf('async function cleanChunks()')
        expect(fnStart).toBeGreaterThan(-1)
        const fnEnd = src.indexOf('\nasync function cleanChunks', fnStart + 1)
        const fnBody = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)

        const guardIndex = fnBody.indexOf('hasMetadataOnlyCharacters(db)')
        const returnIndex = fnBody.indexOf('return', guardIndex)
        const uncleanableIndex = fnBody.indexOf('getUncleanables(db)')

        expect(guardIndex).toBeGreaterThan(-1)
        expect(returnIndex).toBeGreaterThan(guardIndex)
        // The guard's `return` must come before any assets/personas are
        // ever inspected for deletion -- otherwise the "skip entirely"
        // safety property doesn't actually hold.
        expect(uncleanableIndex).toBeGreaterThan(returnIndex)
    })
})
