import { describe, expect, it } from 'vitest'
import { resolveTextTheme } from './textTheme'

describe('editable text theme rendering', () => {
    it('keeps saved custom values when contrast correction is disabled', () => {
        const result = resolveTextTheme('custom', 'light', { FontColorStandard: '#777777' }, { autoContrast: false })
        expect(result.FontColorStandard).toBe('#777777')
    })

    it('returns all text tokens while correcting an unreadable custom color', () => {
        const result = resolveTextTheme('custom', 'light', { FontColorStandard: '#ffffff' }, { autoContrast: true, backgrounds: ['#ffffff'] })
        expect(Object.keys(result)).toHaveLength(6)
        expect(result.FontColorStandard).not.toBe('#ffffff')
    })
})
