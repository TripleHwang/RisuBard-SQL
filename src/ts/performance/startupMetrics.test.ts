import { afterEach, describe, expect, test, vi } from 'vitest'
import {
    markPerformance,
    measurePerformance,
    observeLongTasks,
} from './startupMetrics'

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('startup metrics', () => {
    test('does not throw and returns null when performance APIs are unavailable', () => {
        vi.stubGlobal('performance', undefined)

        expect(() => markPerformance('bootstrap-fetch:start')).not.toThrow()
        expect(measurePerformance('bootstrap-fetch', 'bootstrap-fetch:start')).toBeNull()
    })

    test('prefixes successful marks and measures', () => {
        const mark = vi.fn()
        const measure = vi.fn(() => ({ duration: 42 } as PerformanceMeasure))
        vi.stubGlobal('performance', { mark, measure })

        markPerformance('character-hydration:start')
        const result = measurePerformance(
            'character-hydration',
            'character-hydration:start',
            'character-hydration:end',
        )

        expect(mark).toHaveBeenCalledWith('risu:character-hydration:start')
        expect(measure).toHaveBeenCalledWith(
            'risu:character-hydration',
            'risu:character-hydration:start',
            'risu:character-hydration:end',
        )
        expect(result).toEqual({ duration: 42 })
    })

    test('observes only long tasks above 100ms when supported', () => {
        const observed = vi.fn()
        const disconnected = vi.fn()
        const callback = vi.fn()

        class FakePerformanceObserver {
            constructor(private readonly handler: PerformanceObserverCallback) {}

            observe = observed
            disconnect = disconnected

            emit(durations: number[]) {
                this.handler({
                    getEntries: () => durations.map((duration) => ({ duration } as PerformanceEntry)),
                } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
            }
        }

        let observer: FakePerformanceObserver | undefined
        vi.stubGlobal('PerformanceObserver', class extends FakePerformanceObserver {
            constructor(handler: PerformanceObserverCallback) {
                super(handler)
                observer = this
            }
        })

        const subscription = observeLongTasks(callback)
        observer?.emit([100, 100.01, 180])
        subscription.disconnect()

        expect(observed).toHaveBeenCalledWith({ type: 'longtask', buffered: true })
        expect(callback).toHaveBeenCalledTimes(2)
        expect(callback).toHaveBeenNthCalledWith(1, expect.objectContaining({ duration: 100.01 }))
        expect(callback).toHaveBeenNthCalledWith(2, expect.objectContaining({ duration: 180 }))
        expect(disconnected).toHaveBeenCalledOnce()
    })

    test('provides a clean no-op disconnect when long task observation is unavailable', () => {
        vi.stubGlobal('PerformanceObserver', undefined)

        expect(() => observeLongTasks(vi.fn()).disconnect()).not.toThrow()
    })
})
