import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('settings visual standard', () => {
    test('defines one semantic page, group, and row grammar', () => {
        const page = source('src/lib/UI/GUI/SettingPage.svelte')
        const renderer = source('src/lib/Setting/SettingRenderer.svelte')
        const row = source('src/lib/Setting/Wrappers/SettingRowLayout.svelte')
        const button = source('src/lib/Setting/Wrappers/SettingButton.svelte')
        const segmented = source('src/lib/Setting/Wrappers/SettingSegmented.svelte')
        const color = source('src/lib/Setting/Wrappers/SettingColor.svelte')

        expect(page).toContain('data-settings-page')
        expect(page).toContain('data-settings-page-header')
        expect(page).toContain('data-settings-page-body')
        expect(page).toContain('description?: string')
        expect(renderer).toContain('data-settings-group')
        expect(renderer).toContain("layout = 'row'")
        expect(renderer).toContain('groupedItems')
        expect(row).toContain('data-setting-row')
        expect(button).toContain('<SettingRowLayout')
        expect(segmented).toContain('<SettingRowLayout')
        expect(color).toContain('<SettingRowLayout')
    })

    test('defines the shared Codex-style surface tokens at the settings root', () => {
        const settings = source('src/lib/Setting/Settings.svelte')
        const alert = source('src/lib/UI/GUI/ShAlert.svelte')

        expect(settings).toContain('--settings-content-width')
        expect(settings).toContain('--settings-surface')
        expect(settings).toContain('--settings-border')
        expect(settings).toContain('--settings-radius')
        expect(settings).toContain(':global(.settings-standard-group)')
        expect(settings).toContain('@media (max-width: 520px)')
        expect(settings).toContain('flex-direction: column')
        expect(alert).toContain('settings-alert--info')
        expect(alert).not.toContain('bg-blue-900')
    })

    test('routes exceptional workspaces through the shared page and tab primitives', () => {
        const ai = source('src/lib/Setting/AISettingsWorkspace.svelte')
        const experience = source('src/lib/Setting/ExperienceSettingsWorkspace.svelte')
        const prompt = source('src/lib/Setting/Pages/PromptSettings.svelte')

        expect(ai).toContain('<SettingPage')
        expect(experience).toContain('<SettingPage')
        expect(prompt).toContain('<SettingPage')
        expect(prompt).toContain('<SettingTabs')
    })
})
