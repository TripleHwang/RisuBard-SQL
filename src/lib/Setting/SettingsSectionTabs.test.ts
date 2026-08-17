import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const sharedTabsPath = resolve(process.cwd(), 'src/lib/UI/GUI/SettingsSectionTabs.svelte')
const settingTabsPath = resolve(process.cwd(), 'src/lib/UI/GUI/SettingTabs.svelte')
const aiWorkspacePath = resolve(process.cwd(), 'src/lib/Setting/AISettingsWorkspace.svelte')
const experienceWorkspacePath = resolve(process.cwd(), 'src/lib/Setting/ExperienceSettingsWorkspace.svelte')

describe('settings section tab standard', () => {
    test('provides a single-row horizontally scrollable tablist', () => {
        expect(existsSync(sharedTabsPath)).toBe(true)
        if (!existsSync(sharedTabsPath)) return

        const source = readFileSync(sharedTabsPath, 'utf8')
        expect(source).toContain('data-settings-section-tabs')
        expect(source).toContain('role="tablist"')
        expect(source).toContain('overflow-x: auto')
        expect(source).toContain('white-space: nowrap')
        expect(source).not.toContain('flex-wrap')
    })

    test('backs the existing option tabs with the shared standard', () => {
        const source = readFileSync(settingTabsPath, 'utf8')

        expect(source).toContain("import SettingsSectionTabs from './SettingsSectionTabs.svelte'")
        expect(source).toContain('<SettingsSectionTabs')
    })

    test('uses the shared top tabs for AI and environment at every viewport size', () => {
        const aiSource = readFileSync(aiWorkspacePath, 'utf8')
        const experienceSource = readFileSync(experienceWorkspacePath, 'utf8')

        expect(aiSource).toContain('<SettingsSectionTabs')
        expect(aiSource).not.toContain('mobile-section-tabs')
        expect(aiSource).not.toContain('<nav class="section-navigation"')
        expect(experienceSource).toContain('<SettingsSectionTabs')
    })
})
