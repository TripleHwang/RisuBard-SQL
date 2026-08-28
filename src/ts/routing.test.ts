import { get } from 'svelte/store'
import { beforeEach, describe, expect, test } from 'vitest'
import {
    ModelPresetTab,
    openSettings,
    SettingsRoute,
} from './routing'
import {
    ModelPresetListTabIndex,
    openPersonaManager,
    SettingsMenuIndex,
    settingsOpen,
} from './stores.svelte'

describe('settings routing', () => {
    beforeEach(() => {
        SettingsMenuIndex.set(SettingsRoute.None)
        ModelPresetListTabIndex.set(ModelPresetTab.Presets)
        openPersonaManager.set(false)
        settingsOpen.set(false)
    })

    test('deep-links the model preset page to its Options tab', () => {
        openSettings(SettingsRoute.ModelPreset, undefined, undefined, ModelPresetTab.Options)

        expect(get(SettingsMenuIndex)).toBe(SettingsRoute.ModelPreset)
        expect(get(ModelPresetListTabIndex)).toBe(ModelPresetTab.Options)
        expect(get(settingsOpen)).toBe(true)
    })

    test('opens persona management without navigating to the removed settings page', () => {
        SettingsMenuIndex.set(SettingsRoute.Advanced)

        openSettings(SettingsRoute.Persona)

        expect(get(openPersonaManager)).toBe(true)
        expect(get(SettingsMenuIndex)).toBe(SettingsRoute.Advanced)
        expect(get(settingsOpen)).toBe(true)
    })
})
