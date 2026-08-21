import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ShSelect dropdown positioning', () => {
    it('portals the fixed dropdown to document.body so viewport coordinates stay valid inside transformed dialogs', () => {
        const source = readFileSync('src/lib/UI/GUI/ShSelect.svelte', 'utf8')

        expect(source).toContain('document.body.appendChild(node)')
        expect(source).toMatch(/use:portalToBody/)
    })

    it('restores pointer events for a dropdown portaled outside modal content', () => {
        const source = readFileSync('src/lib/UI/GUI/ShSelect.svelte', 'utf8')

        expect(source).toMatch(/class="[^"]*pointer-events-auto[^"]*"/s)
    })
})
