import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { prepareDynamicAssetSearch } from './dynamicAssetSearch'

describe('dynamic asset post-processing', () => {
    it('checks for asset references before initializing embeddings', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/scripts.ts'),
            'utf8'
        )
        const blockStart = source.indexOf('if(db.dynamicAssets &&')
        const blockEnd = source.indexOf('\n    cacheScript(hash, data)', blockStart)
        expect(blockStart).toBeGreaterThanOrEqual(0)
        expect(blockEnd).toBeGreaterThan(blockStart)
        const block = source.slice(blockStart, blockEnd)
        const matchCheck = block.indexOf('const matches = [...data.matchAll(assetRegex)]')
        const nonEmptyGuard = block.indexOf('if(matches.length > 0)')
        const embeddingInit = block.indexOf('const processer = new HypaProcesser()')

        expect(matchCheck).toBeGreaterThanOrEqual(0)
        expect(nonEmptyGuard).toBeGreaterThan(matchCheck)
        expect(embeddingInit).toBeGreaterThan(nonEmptyGuard)
    })

    it('skips repeat-back actions when the prior message does not match', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/scripts.ts'),
            'utf8'
        )
        const match = source.indexOf('const r = lastChat.match(reg)')
        const nullGuard = source.indexOf('if(!r){', match)
        const firstAccess = source.indexOf('r[0]', match)

        expect(match).toBeGreaterThanOrEqual(0)
        expect(nullGuard).toBeGreaterThan(match)
        expect(firstAccess).toBeGreaterThan(nullGuard)
    })

    it('skips malformed regular expressions without throwing', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/scripts.ts'),
            'utf8'
        )
        const input = source.indexOf('let input = script.in')
        const safeCompile = source.indexOf('const reg = compileScriptRegex(input, flag)', input)
        const nullGuard = source.indexOf('if(!reg){', safeCompile)

        expect(input).toBeGreaterThanOrEqual(0)
        expect(safeCompile).toBeGreaterThan(input)
        expect(nullGuard).toBeGreaterThan(safeCompile)
    })

    it('does not schedule vector preparation for exact or cached display assets', () => {
        const cache = new Map([
            ['char-1::portrait_alias', 'portrait.png'],
        ])
        const result = prepareDynamicAssetSearch(
            '{{image::portrait.png}} {{image::portrait_alias}}',
            'char-1',
            ['portrait.png'],
            [
                { full: '{{image::portrait.png}}', type: 'image', assetName: 'portrait.png' },
                { full: '{{image::portrait_alias}}', type: 'image', assetName: 'portrait_alias' },
            ],
            cache,
        )

        // Exact names already resolve normally; cached fuzzy names are
        // rewritten synchronously. Neither needs HypaProcesser/addText.
        expect(result.unresolved).toEqual([])
        expect(result.data).toBe('{{image::portrait.png}} {{image::portrait.png}}')
    })

    it('keeps only an uncached non-exact asset for vector search', () => {
        const result = prepareDynamicAssetSearch(
            '{{image::portrait_typo}} {{emotion::ignored}} {{source::char}}',
            'char-1',
            ['portrait.png'],
            [
                { full: '{{image::portrait_typo}}', type: 'image', assetName: 'portrait_typo' },
                { full: '{{emotion::ignored}}', type: 'emotion', assetName: 'ignored' },
                { full: '{{source::char}}', type: 'source', assetName: 'char' },
            ],
            new Map(),
        )

        expect(result.unresolved).toEqual([
            {
                full: '{{image::portrait_typo}}',
                type: 'image',
                assetName: 'portrait_typo',
                cacheKey: 'char-1::portrait_typo',
            },
        ])
    })

    it('constructs HypaProcesser only after unresolved candidates are found', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/scripts.ts'),
            'utf8'
        )
        const prepared = source.indexOf('const prepared = prepareDynamicAssetSearch')
        const unresolvedGuard = source.indexOf('if(prepared.unresolved.length > 0)', prepared)
        const embeddingInit = source.indexOf('const processer = new HypaProcesser()', prepared)

        expect(prepared).toBeGreaterThanOrEqual(0)
        expect(unresolvedGuard).toBeGreaterThan(prepared)
        expect(embeddingInit).toBeGreaterThan(unresolvedGuard)
    })
})
