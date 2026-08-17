import { describe, expect, it } from 'vitest'
import {
    createModelAttemptOrder,
    hasNextModelAttempt,
} from './fallbackOrder'

describe('createModelAttemptOrder', () => {
    it('tries the selected model before configured fallbacks', () => {
        const fallbacks = ['fireworks-model', 'backup-model']

        expect(createModelAttemptOrder(fallbacks)).toEqual([
            '',
            'fireworks-model',
            'backup-model',
        ])
        expect(fallbacks).toEqual(['fireworks-model', 'backup-model'])
    })

    it('ignores blank fallback entries', () => {
        expect(createModelAttemptOrder(['', 'backup-model', ''])).toEqual([
            '',
            'backup-model',
        ])
    })

    it('advances after any failed primary when a fallback remains', () => {
        expect(hasNextModelAttempt(0, 2)).toBe(true)
        expect(hasNextModelAttempt(1, 2)).toBe(false)
    })
})
