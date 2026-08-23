import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('RisuBard Memory Wiki help layer', () => {
    test('renders centered above the Memory Wiki dock', () => {
        const source = readFileSync(resolve(
            process.cwd(),
            'src/lib/Others/RisuBardMemoryWikiHelp.svelte',
        ), 'utf8')

        expect(source).toContain('<ShDialog')
        expect(source).toContain('tier="top"')
    })
})
