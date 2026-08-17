import { describe, expect, test } from 'vitest'
import {
    normalizeMemoryWikiDockRatio,
    normalizeMemoryWikiDialogSize,
    normalizeMemoryWikiWorkspaceHeight,
} from './memoryWikiLayout'

describe('memory wiki dialog layout', () => {
    test('normalizes a persistent dock ratio for chat and wiki split layouts', () => {
        expect(normalizeMemoryWikiDockRatio(undefined)).toBe(0.62)
        expect(normalizeMemoryWikiDockRatio(0.1)).toBe(0.3)
        expect(normalizeMemoryWikiDockRatio(0.9)).toBe(0.75)
        expect(normalizeMemoryWikiDockRatio(0.654)).toBe(0.65)
    })

    test('keeps the wiki editor tall while reserving room for the command pane', () => {
        expect(normalizeMemoryWikiWorkspaceHeight(undefined, 900)).toBe(500)
        expect(normalizeMemoryWikiWorkspaceHeight(120, 900)).toBe(288)
        expect(normalizeMemoryWikiWorkspaceHeight(800, 900)).toBe(680)
        expect(normalizeMemoryWikiWorkspaceHeight(460.6, 900)).toBe(461)
    })

    test('uses the saved size without mutating it', () => {
        const saved = { width: 900.4, height: 700.6 }
        const before = structuredClone(saved)

        expect(normalizeMemoryWikiDialogSize(saved, {
            width: 1_440,
            height: 900,
        })).toEqual({
            width: 900,
            height: 701,
        })
        expect(saved).toEqual(before)
    })

    test('clamps corrupt or oversized settings to the current viewport', () => {
        expect(normalizeMemoryWikiDialogSize({
            width: Number.NaN,
            height: 9_999,
        }, {
            width: 800,
            height: 600,
        })).toEqual({
            width: 768,
            height: 568,
        })
    })
})
