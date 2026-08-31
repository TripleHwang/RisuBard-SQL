import { describe, expect, test } from 'vitest'
import {
    ARC_PLOTTER_BUILT_IN_PRESETS,
    ARC_PLOTTER_DEFAULT_SETTINGS,
    createArcPlotterCustomPreset,
    deleteArcPlotterCustomPreset,
    normalizeArcPlotterSettings,
    normalizeArcPlotterRuntimeSettings,
    overwriteArcPlotterCustomPreset,
} from './arcPlotterSettings'

describe('Archplotter settings', () => {
    test('keeps the immutable built-in presets first and defaults to novella', () => {
        expect(ARC_PLOTTER_BUILT_IN_PRESETS.map((preset) => preset.id)).toEqual([
            'short-story',
            'novella',
            'epic',
        ])
        expect(ARC_PLOTTER_BUILT_IN_PRESETS.map((preset) => preset.name)).toEqual([
            '단편소설',
            '중편소설',
            '대하소설',
        ])
        expect(ARC_PLOTTER_DEFAULT_SETTINGS).toEqual(
            ARC_PLOTTER_BUILT_IN_PRESETS[1].settings
        )
    })

    test('normalizes every runtime limit inside the supported safety bounds', () => {
        expect(normalizeArcPlotterSettings({
            checkpointSize: 0,
            maxArcs: 200,
            maxTurningPoints: Number.NaN,
            maxOpenThreads: -5,
            maxCharacters: 99_999,
        })).toEqual({
            checkpointSize: 1,
            maxArcs: 32,
            maxTurningPoints: 16,
            maxOpenThreads: 0,
            maxCharacters: 12_000,
        })
        expect(normalizeArcPlotterRuntimeSettings({ enabled: false }))
            .toMatchObject({ enabled: false, checkpointSize: 8 })
    })

    test('creates, overwrites, and deletes only user presets', () => {
        const settings = normalizeArcPlotterSettings({ checkpointSize: 5 })
        const created = createArcPlotterCustomPreset([], {
            id: 'user:test',
            name: '내 프리셋',
            settings,
        })
        expect(created).toHaveLength(1)
        expect(created[0]).toMatchObject({ id: 'user:test', name: '내 프리셋' })

        const overwritten = overwriteArcPlotterCustomPreset(
            created,
            'user:test',
            { ...settings, maxArcs: 11 }
        )
        expect(overwritten[0].settings.maxArcs).toBe(11)
        expect(overwriteArcPlotterCustomPreset(
            overwritten,
            'novella',
            { ...settings, maxArcs: 2 }
        )).toEqual(overwritten)
        expect(deleteArcPlotterCustomPreset(overwritten, 'novella'))
            .toEqual(overwritten)
        expect(deleteArcPlotterCustomPreset(overwritten, 'user:test')).toEqual([])
    })
})
