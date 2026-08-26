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
        const clearMarks = vi.fn()
        const clearMeasures = vi.fn()
        vi.stubGlobal('performance', { mark, measure, clearMarks, clearMeasures })

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

    test('clears an existing prefixed mark before recording it again', () => {
        const clearMarks = vi.fn()
        const mark = vi.fn()
        vi.stubGlobal('performance', { clearMarks, mark })

        markPerformance('bootstrap-fetch:start')
        markPerformance('bootstrap-fetch:start')

        expect(clearMarks).toHaveBeenCalledTimes(2)
        expect(clearMarks).toHaveBeenCalledWith('risu:bootstrap-fetch:start')
        expect(clearMarks.mock.invocationCallOrder[1]).toBeLessThan(mark.mock.invocationCallOrder[1])
    })

    test('clears a successful measurement and its consumed marks', () => {
        const measure = vi.fn(() => ({ duration: 42 } as PerformanceMeasure))
        const clearMeasures = vi.fn()
        const clearMarks = vi.fn()
        vi.stubGlobal('performance', { measure, clearMeasures, clearMarks })

        const result = measurePerformance(
            'character-hydration',
            'character-hydration:start',
            'character-hydration:end',
        )

        expect(result).toEqual({ duration: 42 })
        expect(clearMeasures).toHaveBeenCalledWith('risu:character-hydration')
        expect(clearMarks).toHaveBeenCalledWith('risu:character-hydration:start')
        expect(clearMarks).toHaveBeenCalledWith('risu:character-hydration:end')
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

    test('continues delivering long tasks after a consumer callback throws', () => {
        let observer: FakePerformanceObserver | undefined
        const received = vi.fn((entry: PerformanceEntry) => {
            if (entry.duration === 101) throw new Error('consumer failure')
        })

        class FakePerformanceObserver {
            constructor(private readonly handler: PerformanceObserverCallback) {}

            observe = vi.fn()
            disconnect = vi.fn()

            emit(durations: number[]) {
                this.handler({
                    getEntries: () => durations.map((duration) => ({ duration } as PerformanceEntry)),
                } as PerformanceObserverEntryList, this as unknown as PerformanceObserver)
            }
        }

        vi.stubGlobal('PerformanceObserver', class extends FakePerformanceObserver {
            constructor(handler: PerformanceObserverCallback) {
                super(handler)
                observer = this
            }
        })

        observeLongTasks(received)

        expect(() => observer?.emit([101, 102])).not.toThrow()
        expect(received).toHaveBeenCalledTimes(2)
        expect(received).toHaveBeenNthCalledWith(2, expect.objectContaining({ duration: 102 }))
    })
})
