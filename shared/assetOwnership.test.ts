import { describe, expect, test } from 'vitest'

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isAssetKeyValue, collectPersonaAssetRefs } = require('./assetOwnership.cjs') as {
    isAssetKeyValue: (value: unknown) => boolean
    collectPersonaAssetRefs: (
        personas: readonly any[] | undefined | null,
        add: (value: unknown) => void,
        opts?: { includeModuleAssets?: boolean },
    ) => void
}

// Mirrors src/ts/globalApi.svelte.ts's getBasename().
function clientBasename(value: string): string {
    return value.replace(/\\/g, '/').split('/').pop()!
}

// Mirrors server/node/server.cjs's statsBasename().
function serverBasename(value: string): string {
    return String(value).replace(/\\/g, '/').split('/').pop()!
}

describe('isAssetKeyValue', () => {
    test('accepts a local asset key', () => {
        expect(isAssetKeyValue('assets/abc123.png')).toBe(true)
    })

    test('rejects empty and nullish values', () => {
        expect(isAssetKeyValue('')).toBe(false)
        expect(isAssetKeyValue(undefined)).toBe(false)
        expect(isAssetKeyValue(null)).toBe(false)
    })

    test('rejects external http(s) URLs', () => {
        expect(isAssetKeyValue('https://example.com/x.png')).toBe(false)
        expect(isAssetKeyValue('http://example.com/x.png')).toBe(false)
    })

    test('rejects inline data: URLs', () => {
        expect(isAssetKeyValue('data:image/png;base64,AAAA')).toBe(false)
    })
})

describe('collectPersonaAssetRefs', () => {
    test('collects each persona icon plus its embedded module icon/assets', () => {
        const seen: unknown[] = []
        collectPersonaAssetRefs(
            [
                {
                    icon: 'assets/a.png',
                    embeddedModule: { icon: 'assets/mod-icon.png', assets: [['x', 'assets/mod-asset.png']] },
                },
                { icon: 'assets/b.png' },
            ],
            (v) => seen.push(v),
        )
        const keys = seen.filter(isAssetKeyValue) as string[]
        expect(keys.sort()).toEqual(
            ['assets/a.png', 'assets/b.png', 'assets/mod-asset.png', 'assets/mod-icon.png'].sort(),
        )
    })

    test('includeModuleAssets:false drops module assets but keeps the module icon', () => {
        const seen: unknown[] = []
        collectPersonaAssetRefs(
            [{ icon: 'assets/a.png', embeddedModule: { icon: 'assets/mod-icon.png', assets: [['x', 'assets/mod-asset.png']] } }],
            (v) => seen.push(v),
            { includeModuleAssets: false },
        )
        const keys = seen.filter(isAssetKeyValue) as string[]
        expect(keys.sort()).toEqual(['assets/a.png', 'assets/mod-icon.png'].sort())
    })

    test('tolerates missing/null/non-array persona lists without throwing', () => {
        const seen: unknown[] = []
        const add = (v: unknown) => seen.push(v)
        expect(() => collectPersonaAssetRefs(undefined, add)).not.toThrow()
        expect(() => collectPersonaAssetRefs(null, add)).not.toThrow()
        expect(() => collectPersonaAssetRefs([null, undefined] as any, add)).not.toThrow()
        expect(seen).toEqual([])
    })
})

// The bug this module fixes: a character-scoped persona icon
// (character.personas[].icon) that shares no content hash with anything
// else was invisible to the old getUncleanables()/buildUncleanableSet(),
// so it looked orphaned and got deleted. These tests reproduce the full
// "global personas + every character's personas" walk both call-sites do,
// using each side's own basename convention, and check they land on the
// identical survivor set.
describe('global + character-scoped survivor set', () => {
    const db = {
        personas: [
            { icon: 'assets/global-unique.png' },
            { icon: 'assets/shared-hash.png' }, // second owner, shared with a character persona below
        ],
        characters: [
            {
                personas: [
                    { icon: 'assets/char-unique-1.png' },
                    { icon: 'assets/shared-hash.png' },
                ],
            },
            {
                personas: [{ icon: 'assets/char-unique-2.png' }],
            },
            // A character with no personas at all must not blow up the walk.
            {},
        ],
    }

    function computeSurvivors(basename: (v: string) => string): Set<string> {
        const set = new Set<string>()
        const add = (v: unknown) => {
            if (isAssetKeyValue(v)) set.add(basename(v as string))
        }
        for (const cha of db.characters) collectPersonaAssetRefs((cha as any).personas, add)
        collectPersonaAssetRefs(db.personas, add)
        return set
    }

    test('client-style and server-style basename wrappers compute the same set', () => {
        const clientLike = computeSurvivors(clientBasename)
        const serverLike = computeSurvivors(serverBasename)
        expect([...clientLike].sort()).toEqual([...serverLike].sort())
    })

    test('every global and character-scoped icon survives, unique or shared', () => {
        const survivors = computeSurvivors(clientBasename)
        expect(survivors.has('global-unique.png')).toBe(true)
        expect(survivors.has('char-unique-1.png')).toBe(true)
        expect(survivors.has('char-unique-2.png')).toBe(true)
        expect(survivors.has('shared-hash.png')).toBe(true)
    })

    test('an asset with no reference anywhere is excluded (a real orphan stays collectible)', () => {
        const survivors = computeSurvivors(clientBasename)
        expect(survivors.has('truly-orphaned.png')).toBe(false)
    })
})
