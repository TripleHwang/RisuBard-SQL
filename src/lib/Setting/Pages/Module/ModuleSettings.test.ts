import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(),
    'src/lib/Setting/Pages/Module/ModuleSettings.svelte',
), 'utf8')

describe('module persona assignment dialog', () => {
    test('associates the persona search input with a label', () => {
        expect(source).toContain('for="persona-module-search"')
        expect(source).toContain('id="persona-module-search"')
        expect(source).toMatch(/<label[^>]*class="sr-only"[^>]*>\{language\.searchPersonas\}<\/label>/)
    })
})
