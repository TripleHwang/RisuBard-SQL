import { describe, expect, test } from 'vitest'
import {
    anchorSaveLoadShortcut,
    normalizeSaveLoadShortcutPlacement,
    resolveSaveLoadShortcutPosition,
} from './saveLoadShortcutLayout'

const composer = {
    left: 80,
    top: 240,
    right: 720,
    bottom: 300,
}
const viewport = { width: 800, height: 320 }
const block = { width: 154, height: 68 }

describe('save/load shortcut anchor layout', () => {
    test('rejects corrupt edge placements', () => {
        expect(normalizeSaveLoadShortcutPlacement(undefined)).toBeNull()
        expect(normalizeSaveLoadShortcutPlacement({
            horizontal: 'right', xOffset: Number.NaN,
            vertical: 'top', yOffset: 12,
        })).toBeNull()
    })

    test('anchors a dragged block to the nearest composer edges', () => {
        expect(anchorSaveLoadShortcut(
            { left: 630, top: 190 },
            composer,
        )).toEqual({
            horizontal: 'right',
            xOffset: 90,
            vertical: 'top',
            yOffset: -50,
        })
    })

    test('preserves edge offsets when the chat pane narrows', () => {
        const placement = anchorSaveLoadShortcut(
            { left: 630, top: 190 },
            composer,
        )

        expect(resolveSaveLoadShortcutPosition(
            placement,
            { ...composer, right: 420 },
            { width: 500, height: 320 },
            block,
        )).toEqual({ left: 330, top: 190 })
    })

    test('keeps an anchored block fully visible inside the chat pane', () => {
        expect(resolveSaveLoadShortcutPosition(
            {
                horizontal: 'right', xOffset: -200,
                vertical: 'bottom', yOffset: -200,
            },
            composer,
            viewport,
            block,
        )).toEqual({ left: 707, top: 270 })
    })
})
