import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

// A persona icon's `assets/<hash>.png` file can 404 (e.g. after an
// already-deleted asset -- see cleanChunks()/getUncleanables()). Without a
// fallback, the browser renders its native broken-image glyph in place of
// the persona badge/tile. These renderers now track icons that failed to
// load and swap to the existing placeholder icon instead, and never render
// an <img> for an empty resolved src (which getCharImage returns when the
// underlying asset read failed).
describe('persona icon 404 fallback', () => {
    test('the main sidebar persona badge falls back to a placeholder icon on load error', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('brokenPersonaIcons')
        expect(sidebar).toContain("brokenPersonaIcons.has(effectivePersona.persona.icon)")
        expect(sidebar).toMatch(/onerror=\{\(\) => brokenPersonaIcons\.add\(effectivePersona\.persona\.icon\)\}/)
    })

    test('the persona bind selector falls back to a placeholder icon on load error', () => {
        const personaBind = source('src/lib/SideBars/PersonaBind.svelte')
        expect(personaBind).toContain('brokenPersonaIcons')
        expect(personaBind).toMatch(/onerror=\{\(\) => brokenPersonaIcons\.add\(displayPersona\.icon\)\}/)
    })

    test('the persona manager grid falls back to a placeholder tile on load error', () => {
        const personaSettings = source('src/lib/Setting/Pages/PersonaSettings.svelte')
        expect(personaSettings).toContain('brokenPersonaIcons')
        expect(personaSettings).toMatch(/onerror=\{\(\) => brokenPersonaIcons\.add\(persona\.icon\)\}/)
        expect(personaSettings).toContain('class="persona-placeholder"')
    })
})
