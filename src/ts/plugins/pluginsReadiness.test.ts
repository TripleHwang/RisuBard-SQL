import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/plugins/plugins.svelte.ts'), 'utf8')

describe('plugin readiness with metadata bootstrap', () => {
    it('publishes readiness after plugin loading settles', () => {
        expect(source).toContain('export const pluginReadyStore')
        expect(source).toMatch(/pluginLoadingStore\.set\(true\)[\s\S]*finally[\s\S]*pluginReadyStore\.set\(true\)/)
    })

    it('does not expose or replace metadata-only characters through v2 plugin APIs', () => {
        expect(source).toContain("character?.detailsLoaded === false ? null : character")
        expect(source).toContain("throw new Error('Character details are still loading')")
    })
})
