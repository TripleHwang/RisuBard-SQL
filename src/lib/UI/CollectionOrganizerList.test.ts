import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const root = process.cwd()

function source(path: string) {
    return readFileSync(resolve(root, path), 'utf8')
}

describe('inline collection organizer list', () => {
    test('renders organization and parent item actions in the default list instead of a dialog', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')

        expect(component).not.toContain('ShDialog')
        expect(component).toContain("import type { Snippet }")
        expect(component).toContain('itemContent')
        expect(component).toContain('{@render itemContent(item.id)}')
        expect(component).toContain('md:grid-cols-[var(--collection-sidebar-width,13rem)_minmax(0,1fr)]')
    })

    test('adds an accessible desktop-only pane resizer without replacing the responsive stacked layout', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')

        expect(component).toContain("import { resizeHandle } from 'src/ts/gui/resizeHandle'")
        expect(component).toContain('data-collection-pane-resizer')
        expect(component).toContain('aria-label={copy.resizePanes}')
        expect(component).toContain('use:resizeHandle={{ start: startPaneResize, reset: resetPaneResize }}')
        expect(component).toContain('@media (max-width: 767px) { .collection-organizer__pane-resizer { display: none; } }')
    })

    test('keeps folder deletion, immediate persistence, bulk movement, and accessible reorder controls inline', () => {
        const component = source('src/lib/UI/CollectionOrganizerList.svelte')

        expect(component).toContain('deleteCollectionFolder')
        expect(component).toContain('requestImmediateSave')
        expect(component).toContain('assignItemsToFolder')
        expect(component).toContain('moveFolderUp')
        expect(component).toContain('moveItemDown')
        expect(component).toContain('GripVerticalIcon')
        expect(component).toContain('data-collection-drag-handle')
        expect(component).toContain('selectedItemIds.filter((id) => itemIds.includes(id))')
    })

    test('prompt presets render their native actions inside the inline organizer', () => {
        const page = source('src/lib/Setting/botpreset.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(presetId)}')
        expect(page).toContain('copyPreset(i)')
        expect(page).toContain("downloadPreset(i, 'risupreset')")
        expect(page).toContain('assignPresetToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })

    test('modules render native enable, persona, export, edit, and delete actions inline', () => {
        const page = source('src/lib/Setting/Pages/Module/ModuleSettings.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(moduleId)}')
        expect(page).toContain('openPersonaAssignments(rmodule.id)')
        expect(page).toContain('exportModule(rmodule)')
        expect(page).toContain('assignModuleToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })

    test('plugins render native update, toggle, permission, arguments, and delete actions inline', () => {
        const page = source('src/lib/Setting/Pages/PluginSettings.svelte')

        expect(page).toContain('CollectionOrganizerList')
        expect(page).toContain('{#snippet itemContent(pluginName)}')
        expect(page).toContain('runInstalledPluginUpdateAction(plugin')
        expect(page).toContain('update: updatePlugin')
        expect(page).toContain('notifyError(language.pluginUpdateFailed)')
        expect(page).toContain('assignPluginToFolder')
        expect(page).not.toContain('CollectionOrganizerDialog')
        expect(page).not.toContain('organizerOpen')
    })

    test('module and plugin item controls can wrap in their responsive organizer panes', () => {
        const modulePage = source('src/lib/Setting/Pages/Module/ModuleSettings.svelte')
        const pluginPage = source('src/lib/Setting/Pages/PluginSettings.svelte')

        expect(modulePage).toContain('flex flex-wrap items-center gap-x-2 gap-y-1')
        expect(modulePage).toContain('ml-auto flex flex-wrap justify-end gap-y-1')
        expect(pluginPage).toContain('flex flex-wrap items-start gap-2')
        expect(pluginPage).toContain('min-w-0 grow break-words font-bold')
    })
})
