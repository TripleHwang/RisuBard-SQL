import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('Character Vault sidebar integration', () => {
    test('places Character Vault below persona and above the quick inventory', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar.indexOf('data-sidebar-persona'))
            .toBeLessThan(sidebar.indexOf('data-character-vault-button'))
        expect(sidebar.indexOf('data-character-vault-button'))
            .toBeLessThan(sidebar.indexOf('data-quick-inventory'))
    })

    test('labels persona as a rail section and keeps Vault as an unlabeled square action', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const personaStart = sidebar.indexOf('data-sidebar-persona')
        const vaultStart = sidebar.indexOf('data-character-vault-button')
        const inventoryStart = sidebar.indexOf('data-quick-inventory')
        const persona = sidebar.slice(personaStart, vaultStart)
        const vault = sidebar.slice(vaultStart, inventoryStart)
        expect(persona).toContain('data-sidebar-persona-label')
        expect(persona).toContain('text-white')
        expect(persona.indexOf('data-sidebar-persona-label'))
            .toBeLessThan(persona.indexOf('<button'))
        expect(vault).toContain('character-toolbar-button--chat')
        expect(vault).not.toContain('border-b')
        expect(vault).not.toMatch(/>Vault<\/span>/)
    })

    test('aligns the square rail options control with the workspace header divider', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('data-sidebar-options')
        expect(sidebar).toContain('data-sidebar-options-divider')
        expect(sidebar).toMatch(/data-sidebar-options[\s\S]*size-10[\s\S]*data-sidebar-options-divider/)
        expect(sidebar).toContain('bg-darkbg pt-2 pb-6 text-textcolor')
        expect(sidebar).toMatch(/data-character-workspace-header class="flex min-h-10/)
        expect(sidebar).not.toMatch(/data-character-workspace-header class="[^"]*mt-1\.5/)
    })

    test('renders entries from the stable quick-access projection', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('getCharacterVaultQuickAccess')
        expect(sidebar).toContain('<CharacterVaultDialog')
    })

    test('exposes one shared modal state from the app stores', () => {
        expect(source('src/ts/stores.svelte.ts'))
            .toContain('export const characterVaultOpen = writable(false)')
    })

    test('renders custom folder colors in the quick inventory', () => {
        expect(source('src/lib/SideBars/SidebarAvatar.svelte'))
            .toContain("color.startsWith('#') ? color : undefined")
    })

    test('resolves quick folder context actions by stable folder id', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('const folderIndex = getFolderIndex(char.id)')
    })

    test('supports Escape dismissal and a true mobile fullscreen Vault', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        expect(dialog).toContain('closeOnEscape')
        expect(dialog).toContain('max-width: 100vw !important')
    })

    test('uses the defined theme tokens for opaque Vault surfaces', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        expect(dialog).toContain('var(--color-darkbg)')
        expect(dialog).not.toMatch(
            /var\(--(?:darkbg|darkborderc|borderc|selected|textcolor|textcolor2)\)/
        )
    })

    test('uses the requested Solar Bold icons for Vault actions', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        const icons = source('src/lib/UI/Icons/SolarBoldIcon.svelte')
        for (const name of [
            'add-folder',
            'remove-folder',
            'trash-bin-trash',
            'play-circle',
        ]) {
            expect(icons).toContain(`| '${name}'`)
            expect(dialog).toContain(`name="${name}"`)
        }
    })

    test('renders wider 4:3 character cards with the open action in the portrait', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        expect(dialog).toContain('aspect-ratio: 4 / 3')
        expect(dialog).toContain('class="open-character"')
        expect(dialog.indexOf('class="open-character"'))
            .toBeLessThan(dialog.indexOf('class="character-caption"'))
    })
})
