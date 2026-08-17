import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { settingsSections } from 'src/ts/setting/settingsNavigation'
import { SettingsRoute } from 'src/ts/routing'

const componentPath = resolve(process.cwd(), 'src/lib/Setting/SettingsNavigation.svelte')
const workspacePath = resolve(process.cwd(), 'src/lib/Setting/Settings.svelte')

describe('SettingsNavigation', () => {
    test('places RisuBard common, wiki prompt, and chat pages directly below AI', () => {
        expect(settingsSections.map((section) => section.id).slice(0, 3)).toEqual([
            'ai',
            'risubard',
            'experience',
        ])
        expect(settingsSections[1].items).toEqual([
            expect.objectContaining({ id: 'risubard-common', route: SettingsRoute.RisuBardCommon }),
            expect.objectContaining({ id: 'risubard-wiki-prompt', route: SettingsRoute.RisuBardWikiPrompt }),
            expect.objectContaining({ id: 'risubard-chat', route: SettingsRoute.RisuBardChat }),
        ])
    })

    test('exposes the workspace navigation landmarks', () => {
        const source = readFileSync(componentPath, 'utf8')

        expect(source).toContain('data-settings-navigation')
        expect(source).toContain('data-settings-section')
        expect(source).toContain("aria-current={isSettingsNavigationItemActive(item, activeRoute) ? 'page' : undefined}")
    })

    test('provides search, close, and mobile back actions', () => {
        const source = readFileSync(componentPath, 'utf8')

        expect(source).toContain('data-settings-search')
        expect(source).toContain('data-settings-close')
        expect(source).toContain('data-settings-mobile-back')
        expect(source).toContain('{#if !mobile}<kbd>Ctrl K</kbd>{/if}')
    })

    test('connects the advertised search shortcut to the workspace', () => {
        const source = readFileSync(workspacePath, 'utf8')

        expect(source).toContain("event.key.toLowerCase() === 'k'")
        expect(source).toContain('event.ctrlKey || event.metaKey')
    })
})
