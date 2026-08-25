import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (path: string) => readFileSync(path, 'utf8')

describe('in-app update settings', () => {
    test('exposes a manual update tab and searchable navigation entry', () => {
        const settings = read('src/lib/Setting/Pages/SystemSettings.svelte')
        const routing = read('src/ts/routing.ts')
        const search = read('src/ts/setting/searchManifestData.ts')

        expect(settings).toContain("import SystemUpdate from './SystemUpdate.svelte'")
        expect(settings).toContain('language.systemUpdateTab')
        expect(routing).toContain('Updates: 6 as const')
        expect(search).toContain("id: 'manual.system.updates'")
        expect(search).toContain('subTab: SystemTab.Updates')
    })

    test('manual checks do not force the startup popup and only apply compatible builds', () => {
        const page = read('src/lib/Setting/Pages/SystemUpdate.svelte')
        const update = read('src/ts/update.ts')

        expect(page).toContain('checkRisuUpdate({ showPopup: false })')
        expect(page).toContain('info.canSelfUpdate')
        expect(page).toContain('updatePopupStore.set(info)')
        expect(update).toContain('options.showPopup !== false')
    })
})
