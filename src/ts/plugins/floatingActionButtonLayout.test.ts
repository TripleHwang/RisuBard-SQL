import { describe, expect, test } from 'vitest'
import {
    defaultFabPosition,
    findOwnedMenuIndex,
    makeFabLayoutKey,
    normalizeFabPlacement,
    placementFromClientPoint,
    resolveFabPosition,
} from './floatingActionButtonLayout'

const viewport = { width: 400, height: 300 }
const button = { width: 52, height: 36 }

describe('floating action button layout', () => {
    test('namespaces stable button IDs by plugin', () => {
        expect(makeFabLayoutKey('plugin-a', 'main', 'Launch'))
            .toBe('["plugin-a","id","main"]')
        expect(makeFabLayoutKey('plugin-b', 'main', 'Launch'))
            .toBe('["plugin-b","id","main"]')
    })

    test('uses a deterministic name fallback when a plugin omits an ID', () => {
        expect(makeFabLayoutKey('plugin-a', undefined, 'Launch'))
            .toBe('["plugin-a","name","Launch"]')
    })

    test('finds menu entries only inside the owning plugin namespace', () => {
        const items = [
            { pluginName: 'plugin-a', id: 'main' },
            { pluginName: 'plugin-b', id: 'main' },
        ]

        expect(findOwnedMenuIndex(items, 'plugin-a', 'main')).toBe(0)
        expect(findOwnedMenuIndex(items, 'plugin-b', 'main')).toBe(1)
        expect(findOwnedMenuIndex(items, 'plugin-c', 'main')).toBe(-1)
    })

    test('keeps new buttons in a non-overlapping top-right stack', () => {
        expect(defaultFabPosition(0, viewport, button)).toEqual({
            left: 358,
            top: 34,
        })
        expect(defaultFabPosition(1, viewport, button)).toEqual({
            left: 358,
            top: 82,
        })
    })

    test('wraps a long default stack into the next column', () => {
        expect(defaultFabPosition(5, viewport, button)).toEqual({
            left: 294,
            top: 34,
        })
    })

    test('keeps the default position visible in a tiny viewport', () => {
        expect(defaultFabPosition(0, { width: 40, height: 20 }, button))
            .toEqual({ left: 20, top: 10 })
    })

    test('rejects corrupt placements and clamps finite ratios', () => {
        expect(normalizeFabPlacement(undefined)).toBeNull()
        expect(normalizeFabPlacement({ xRatio: Number.NaN, yRatio: 0.5 }))
            .toBeNull()
        expect(normalizeFabPlacement({ xRatio: 2, yRatio: -1 })).toEqual({
            xRatio: 1,
            yRatio: 0,
        })
    })

    test('clamps drag coordinates to the visible viewport gutter', () => {
        expect(placementFromClientPoint(-100, 900, viewport, button)).toEqual({
            xRatio: 0.105,
            yRatio: 0.8866666666666667,
        })
        expect(resolveFabPosition(
            { xRatio: 0.105, yRatio: 0.8866666666666667 },
            0,
            viewport,
            button
        )).toEqual({
            left: 42,
            top: 266,
        })
    })
})
