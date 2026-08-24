import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('application overlay layering', () => {
    test('keeps BardWiki below statistics, dialogs, and top confirmations', () => {
        const wiki = source('src/lib/Others/RisuBardMemoryWiki.svelte')
        const toaster = source('src/lib/UI/GUI/Toaster.svelte')
        const dialog = source('src/lib/UI/GUI/ShDialog.svelte')
        const alert = source('src/lib/UI/GUI/ShAlertDialog.svelte')
        const loading = source('src/lib/UI/GUI/ShLoadingDialog.svelte')

        expect(wiki).toMatch(/\.memory-wiki-dock\s*\{[\s\S]*?z-index:\s*51/)
        expect(toaster).toContain('z-index: 55 !important')
        for (const component of [dialog, alert, loading]) {
            expect(component).toContain("alert: 'z-[2147483600]'")
            expect(component).toContain("top: 'z-[2147483640]'")
        }
        expect(alert).toContain("tier = 'top'")
    })

    test('places the reboot choice dialog in the top confirmation tier', () => {
        const wiki = source('src/lib/Others/RisuBardMemoryWiki.svelte')
        const chooser = wiki.slice(
            wiki.indexOf('{#if rebootChooserOpen}'),
            wiki.indexOf('{#snippet rebootChooserFooter')
        )
        expect(chooser).toContain('tier="top"')
    })
})
