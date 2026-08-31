import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const moduleMenuSource = readFileSync(
    resolve(process.cwd(), 'src/lib/Setting/Pages/Module/ModuleMenu.svelte'),
    'utf8',
)

describe('module asset editor rendering', () => {
    it('only renders and previews a bounded page of large asset modules', () => {
        expect(moduleMenuSource).toContain('const moduleAssetPageSize = 24')
        expect(moduleMenuSource).toContain('submenu !== 5')
        expect(moduleMenuSource).toContain('currentModule.assets.slice(0, visibleAssetCount)')
        expect(moduleMenuSource).toContain('visibleAssetCount += moduleAssetPageSize')
    })
})
