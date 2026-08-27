import { describe, expect, it } from 'vitest'
import {
    autoSaveId,
    classifyMemorySaveId,
    normalizeAutosaveInterval,
    normalizeAutosaveRetention,
    obsoleteAutosaveIds,
    quickSaveId,
    shouldCreateAutosave,
} from './memorySavePolicy'

describe('RisuBard memory save policy', () => {
    it('uses one stable quicksave ID per chat', () => {
        expect(quickSaveId('chat-a')).toBe(quickSaveId('chat-a'))
        expect(quickSaveId('chat-a')).not.toBe(quickSaveId('chat-b'))
        expect(classifyMemorySaveId(quickSaveId('chat-a'))).toEqual({
            kind: 'quick',
        })
    })

    it('autosaves turns 1, 6 and 11 for an interval of five', () => {
        expect([1, 2, 5, 6, 10, 11].filter((turn) =>
            shouldCreateAutosave(turn, 5)
        )).toEqual([1, 6, 11])
    })

    it('does not repeat an autosave already recorded for the same turn', () => {
        expect(shouldCreateAutosave(6, 5, 6)).toBe(false)
        expect(shouldCreateAutosave(6, 5, 1)).toBe(true)
    })

    it('rotates auto slots within the configured retention count', () => {
        const ids = [1, 6, 11, 16].map((turn) =>
            autoSaveId('chat-a', turn, 5, 3)
        )
        expect(ids[0]).toBe(ids[3])
        expect(new Set(ids).size).toBe(3)
        expect(classifyMemorySaveId(ids[1])).toEqual({
            kind: 'auto',
            index: 1,
        })
    })

    it('classifies ordinary UUID slots as manual', () => {
        expect(classifyMemorySaveId('c1a24c8f-ordinary')).toEqual({
            kind: 'manual',
        })
    })

    it('normalizes autosave settings to bounded integers', () => {
        expect(normalizeAutosaveInterval(undefined)).toBe(5)
        expect(normalizeAutosaveInterval(7.8)).toBe(7)
        expect(normalizeAutosaveInterval(0)).toBe(1)
        expect(normalizeAutosaveInterval(999)).toBe(100)
        expect(normalizeAutosaveRetention(undefined)).toBe(5)
        expect(normalizeAutosaveRetention(0)).toBe(1)
        expect(normalizeAutosaveRetention(99)).toBe(20)
    })

    it('prunes only this chat autosave slots outside reduced retention', () => {
        const own = [0, 1, 2, 3, 4].map((index) =>
            autoSaveId('chat-a', 1 + index * 5, 5, 5)
        )
        const other = autoSaveId('chat-b', 16, 5, 5)
        expect(obsoleteAutosaveIds([...own, other], 'chat-a', 3))
            .toEqual([own[3], own[4]])
    })
})
