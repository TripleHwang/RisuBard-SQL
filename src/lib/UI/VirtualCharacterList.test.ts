import { expect, it } from 'vitest'
import { visibleRange } from './virtualCharacterList'

it('keeps mounted rows to viewport plus overscan', () => {
  expect(visibleRange({ count: 200, scrollTop: 0, height: 680, rowHeight: 68, overscan: 8 })).toEqual({ start: 0, end: 18 })
})

it('clamps scrolled ranges to the list', () => {
  expect(visibleRange({ count: 20, scrollTop: 9999, height: 68, rowHeight: 68, overscan: 8 })).toEqual({ start: 11, end: 20 })
})
