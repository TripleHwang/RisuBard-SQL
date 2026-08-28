import { describe, expect, it } from 'vitest'
import { risuBardCommonSettingsItems } from './risuBardCommonSettingsData'

describe('RisuBard common Arca settings', () => {
    it('lets number inputs keep intermediate draft values while typing', () => {
        const numericSettingIds = [
            'risubard.common.arcaChatImageWidth',
            'risubard.common.arcaChatFontSize',
            'risubard.common.arcaChatParagraphSpacing',
        ]

        for (const id of numericSettingIds) {
            const item = risuBardCommonSettingsItems.find((candidate) => candidate.id === id)
            expect(item?.type).toBe('number')
            expect(item?.setValue).toBeUndefined()
        }
    })
})
