import { describe, expect, test } from 'vitest'
import { readJsHeap } from './heapUsage'

describe('JS heap reading', () => {
    test('reports Chromium numbers when the runtime exposes them', () => {
        expect(readJsHeap({ memory: { usedJSHeapSize: 12_000_000, totalJSHeapSize: 20_000_000 } }))
            .toEqual({ usedBytes: 12_000_000, totalBytes: 20_000_000, supported: true })
    })

    test('reports unknown, never zero, on a runtime without performance.memory', () => {
        // This is Safari, and therefore iOS. A zero here would be recorded as a
        // measurement, and the report would claim the platform whose memory
        // ceiling started this work uses none.
        for (const runtime of [undefined, {}, { memory: undefined }, { memory: null }]) {
            expect(readJsHeap(runtime)).toEqual({ usedBytes: null, totalBytes: null, supported: false })
        }
    })

    test('rejects nonsense values instead of recording them', () => {
        expect(readJsHeap({ memory: { usedJSHeapSize: Number.NaN, totalJSHeapSize: -1 } }))
            .toEqual({ usedBytes: null, totalBytes: null, supported: false })
        expect(readJsHeap({ memory: { usedJSHeapSize: 5, totalJSHeapSize: 'lots' } }))
            .toEqual({ usedBytes: 5, totalBytes: null, supported: true })
    })

    test('never throws, whatever the accessor does', () => {
        const hostile = { get memory(): never { throw new Error('blocked') } }
        expect(readJsHeap(hostile)).toEqual({ usedBytes: null, totalBytes: null, supported: false })
    })
})
