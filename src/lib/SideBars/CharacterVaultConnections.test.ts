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

    test('keeps persona and Vault as unlabeled square actions with separated sections', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const personaStart = sidebar.indexOf('data-sidebar-persona')
        const vaultStart = sidebar.indexOf('data-character-vault-button')
        const inventoryStart = sidebar.indexOf('data-quick-inventory')
        const persona = sidebar.slice(personaStart, vaultStart)
        const vault = sidebar.slice(vaultStart, inventoryStart)
        expect(persona).not.toContain('data-sidebar-persona-label')
        expect(persona).toContain('border-b border-b-selected')
        expect(persona).toContain('mb-2')
        expect(vault).toContain('character-toolbar-button--chat')
        expect(vault).not.toContain('border-b')
        expect(vault).not.toMatch(/>Vault<\/span>/)
    })

    test('uses the books artwork and swaps to its animation on hover', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const vaultStart = sidebar.indexOf('data-character-vault-button')
        const inventoryStart = sidebar.indexOf('data-quick-inventory')
        const vault = sidebar.slice(vaultStart, inventoryStart)
        expect(sidebar).toContain("import characterVaultIdle from 'src/assets/character-vault/books1-idle.png'")
        expect(sidebar).toContain("import characterVaultHover from 'src/assets/character-vault/books1-hover.gif'")
        expect(vault).toContain('src={characterVaultIdle}')
        expect(vault).toContain('src={characterVaultHover}')
        expect(vault).toContain('group-hover:opacity-0')
        expect(vault).toContain('group-hover:opacity-100')
        expect(vault).toContain('style="width: 56px; height: 56px;"')
        expect(vault).not.toContain('<ArchiveIcon')
    })

    test('aligns the square rail options control with the workspace header divider', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('data-sidebar-options')
        expect(sidebar).toContain('data-sidebar-options-divider')
        expect(sidebar).toMatch(/data-sidebar-options[\s\S]*size-10[\s\S]*data-sidebar-options-divider/)
        expect(sidebar).toMatch(/data-sidebar-options-divider class="w-full relative text-white"/)
        expect(sidebar).not.toContain('data-sidebar-options-divider class="w-full border-b border-b-selected')
        expect(sidebar).toContain('bg-darkbg pt-2 pb-6 text-textcolor')
        expect(sidebar).toMatch(/data-character-workspace-header class="flex min-h-10/)
        expect(sidebar).not.toMatch(/data-character-workspace-header class="[^"]*mt-1\.5/)
    })

    test('renders entries from the stable quick-access projection', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('getCharacterVaultQuickAccess')
        expect(sidebar).toContain('<CharacterVaultDialog')
    })

    test('pins successful CharX imports at the top of quick access', () => {
        const cards = source('src/ts/characterCards.ts')
        const charxStart = cards.indexOf("if(f.name.endsWith('charx')")
        const pngStart = cards.indexOf("if(!f.name.endsWith('png')", charxStart)
        const charxImport = cards.slice(charxStart, pngStart)
        expect(cards).toContain("import { pinCharacterVaultQuickAccess } from './characterVault'")
        expect(charxImport).toContain('pinCharacterVaultQuickAccess(db, importedCharacter.chaId)')
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

    test('grows the mobile folder rail with viewport height and keeps it vertically scrollable', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        expect(dialog).toMatch(
            /\.folder-list\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/s
        )
        expect(dialog).toContain(
            'grid-template-rows: clamp(10rem, 34dvh, 22rem) minmax(0, 1fr)'
        )
        expect(dialog).not.toContain('.folder-list { display: flex;')
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
