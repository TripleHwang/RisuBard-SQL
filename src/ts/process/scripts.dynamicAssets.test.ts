import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

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
})
