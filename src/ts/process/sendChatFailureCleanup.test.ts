import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('sendChat request failure cleanup', () => {
    it('releases the per-chat generation lock before returning', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/index.svelte.ts'),
            'utf8'
        )
        const branchStart = source.indexOf("if(req.type === 'fail'){")
        const branchEnd = source.indexOf(
            "else if(req.type === 'streaming')",
            branchStart
        )
        expect(branchStart).toBeGreaterThanOrEqual(0)
        expect(branchEnd).toBeGreaterThan(branchStart)
        const failureBranch = source.slice(branchStart, branchEnd)

        expect(failureBranch).toContain('endGeneration(genKey)')
    })
})
