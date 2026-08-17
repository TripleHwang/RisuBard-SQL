import { describe, expect, test } from 'vitest'
import { vi } from 'vitest'

vi.mock('../plugins/plugins.svelte', () => ({ loadPlugins: vi.fn() }))
import {
    advancedContextItems,
    advancedPromptItems,
    advancedRequestItems,
    advancedResponseItems,
    advancedInterfaceItems,
    advancedFeatureItems,
    advancedCompatibilityItems,
    advancedExperimentalItems,
    advancedUtilityItems,
    advancedSettingsItems,
} from './advancedSettingsData'

describe('advanced settings information architecture', () => {
    test('places every setting in exactly one purposeful section', () => {
        const sections = [
            advancedContextItems,
            advancedPromptItems,
            advancedRequestItems,
            advancedResponseItems,
            advancedInterfaceItems,
            advancedFeatureItems,
            advancedCompatibilityItems,
            advancedExperimentalItems,
            advancedUtilityItems,
        ]
        const sectionIds = sections.flatMap((items) => items.map((item) => item.id))
        const allIds = advancedSettingsItems.map((item) => item.id)

        expect(new Set(sectionIds).size).toBe(sectionIds.length)
        expect(sectionIds).toEqual(allIds)
    })

    test('uses multiline editors for prompt bodies', () => {
        expect(advancedPromptItems.find((item) => item.id === 'adv.addPrompt')?.type).toBe('textarea')
        expect(advancedPromptItems.find((item) => item.id === 'adv.descPrefix')?.type).toBe('textarea')
        expect(advancedPromptItems.find((item) => item.id === 'adv.emoPrompt')?.type).toBe('textarea')
        expect(advancedPromptItems.find((item) => item.id === 'adv.presetChain')?.type).toBe('text')
    })
})
