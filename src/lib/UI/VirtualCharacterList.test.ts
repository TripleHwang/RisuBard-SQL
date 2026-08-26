import { expect, it } from 'vitest'
import { nextRovingIndex, reconcileFocus, scrollTopForIndex, visibleRange } from './virtualCharacterList'

it('keeps mounted rows to viewport plus overscan', () => {
  expect(visibleRange({ count: 200, scrollTop: 0, height: 680, rowHeight: 68, overscan: 8 })).toEqual({ start: 0, end: 18 })
})

it('retains focus by character key through filtering and reordering', () => {
  expect(reconcileFocus(['a', 'b', 'c'], 'b', 0)).toEqual({ key: 'b', index: 1 })
  expect(reconcileFocus(['c', 'b', 'a'], 'b', 1)).toEqual({ key: 'b', index: 1 })
  expect(reconcileFocus(['a', 'c'], 'b', 1)).toEqual({ key: 'c', index: 1 })
})

it('clamps scrolled ranges to the list', () => {
  expect(visibleRange({ count: 20, scrollTop: 9999, height: 68, rowHeight: 68, overscan: 8 })).toEqual({ start: 11, end: 20 })
})

it('moves logical focus within character bounds and scrolls it into view', () => {
  expect(nextRovingIndex(0, 'ArrowUp', 20)).toBe(0)
  expect(nextRovingIndex(0, 'ArrowDown', 20)).toBe(1)
  expect(nextRovingIndex(19, 'ArrowDown', 20)).toBe(19)
  expect(scrollTopForIndex(15, 0, 680, 68)).toBe(408)
})
