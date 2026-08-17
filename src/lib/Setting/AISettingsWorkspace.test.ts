import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const workspacePath = resolve(process.cwd(), 'src/lib/Setting/AISettingsWorkspace.svelte')
const settingsPath = resolve(process.cwd(), 'src/lib/Setting/Settings.svelte')
const settingPagePath = resolve(process.cwd(), 'src/lib/UI/GUI/SettingPage.svelte')
describe('AISettingsWorkspace', () => {
    test('provides a shared top tab navigator and mounts embedded detail pages', () => {
        const source = readFileSync(workspacePath, 'utf8')

        expect(source).toContain('data-ai-settings-workspace')
        expect(source).toContain('<SettingsSectionTabs')
        expect(source).not.toContain('<nav class="section-navigation"')
        expect(source).toContain('<ModelPresetSettings embedded />')
        expect(source).toContain('<PromptPresetSettings embedded />')
        expect(source).toContain('<BotSettings embedded />')
        expect(source).toContain('<OtherBotSettings embedded />')
    })

    test('routes all legacy AI entry points through the unified workspace', () => {
        const source = readFileSync(settingsPath, 'utf8')

        expect(source).toContain('isAISettingsRoute($SettingsMenuIndex as SettingsRouteValue)')
        expect(source).toContain('<AISettingsWorkspace')
    })

    test('lets embedded settings pages defer their heading to the workspace', () => {
        const settingPage = readFileSync(settingPagePath, 'utf8')

        expect(settingPage).toContain('showTitle = true')
        expect(settingPage).toContain('{#if showTitle}')

        for (const path of [
            'src/lib/Setting/Pages/BotSettings.svelte',
            'src/lib/Setting/Pages/OtherBotSettings.svelte',
            'src/lib/Setting/Pages/PromptPresetSettings.svelte',
            'src/lib/Setting/Pages/Model/ModelPresetSettings.svelte',
        ]) {
            const source = readFileSync(resolve(process.cwd(), path), 'utf8')
            expect(source).toContain('embedded = false')
            expect(source).toContain('showTitle={!embedded}')
        }
    })
})
