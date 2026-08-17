import { describe, expect, it } from 'vitest'
import { canRunLorebookSweep, isLorebookEntryEnabled } from './lorebookActivation'
import type { loreBook } from '../storage/database.svelte'

describe('canRunLorebookSweep', () => {
    it('keeps recursion unlimited when max steps is zero', () => {
        expect(canRunLorebookSweep(0, 0)).toBe(true)
        expect(canRunLorebookSweep(20, 0)).toBe(true)
        expect(canRunLorebookSweep(20, -1)).toBe(true)
    })

    it('counts the initial scan as the first step', () => {
        expect(canRunLorebookSweep(0, 1)).toBe(true)
        expect(canRunLorebookSweep(1, 1)).toBe(false)
    })

    it('stops after the configured number of scan sweeps', () => {
        expect(canRunLorebookSweep(1, 2)).toBe(true)
        expect(canRunLorebookSweep(2, 2)).toBe(false)
    })
})

describe('isLorebookEntryEnabled', () => {
    it('only disables entries explicitly set to false', () => {
        expect(isLorebookEntryEnabled({ enabled: false } as loreBook)).toBe(false)
        expect(isLorebookEntryEnabled({ enabled: true } as loreBook)).toBe(true)
        expect(isLorebookEntryEnabled({} as loreBook)).toBe(true)
    })
})
