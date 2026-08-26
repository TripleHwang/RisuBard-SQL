import { describe, expect, it, vi } from 'vitest'
import { createRuntimeMetrics } from './runtimeMetrics'

describe('runtime metrics', () => {
    it('uses content-free invocation marks and a fixed public measure name', () => {
        const marks: string[] = []
        const measure = vi.fn()
        const metrics = createRuntimeMetrics({ mark: name => { marks.push(name) }, measure })

        const handle = metrics.start('bootstrap')
        metrics.end(handle)

        expect(marks).toEqual(['risu:bootstrap:start:1', 'risu:bootstrap:end:1'])
        expect(measure).toHaveBeenCalledWith('risu:bootstrap', 'risu:bootstrap:start:1', 'risu:bootstrap:end:1')
    })

    it('pairs overlapping calls with content-free invocation marks', () => {
        const marks: string[] = []
        const measures: unknown[][] = []
        const cleared: string[] = []
        const metrics = createRuntimeMetrics({
            mark: name => { marks.push(name) },
            measure: (...args) => { measures.push(args) },
            clearMarks: name => { cleared.push(name) },
        })

        const first = metrics.start('message-page')
        const second = metrics.start('message-page')
        metrics.end(first)
        metrics.end(second)

        expect(marks).toEqual([
            'risu:message-page:start:1',
            'risu:message-page:start:2',
            'risu:message-page:end:1',
            'risu:message-page:end:2',
        ])
        expect(measures).toEqual([
            ['risu:message-page', 'risu:message-page:start:1', 'risu:message-page:end:1'],
            ['risu:message-page', 'risu:message-page:start:2', 'risu:message-page:end:2'],
        ])
        expect(cleared).toEqual([
            'risu:message-page:start:1', 'risu:message-page:end:1',
            'risu:message-page:start:2', 'risu:message-page:end:2',
        ])
    })

    it('is safe when performance is absent or marks throw', () => {
        expect(() => {
            const metrics = createRuntimeMetrics(undefined)
            metrics.end(metrics.start('dirty-commit'))
        }).not.toThrow()
        const metrics = createRuntimeMetrics({ mark: () => { throw new Error('unsupported') }, measure: () => { throw new Error('unsupported') } })
        expect(() => { metrics.end(metrics.start('stream-render')) }).not.toThrow()
    })

    it('bridges existing runtime spans to content-free report metric names', () => {
        const reported: Array<[string, number]> = []
        const metrics = createRuntimeMetrics({ mark: () => undefined, measure: () => undefined }, (name, duration) => {
            reported.push([name, duration])
        })

        metrics.end(metrics.start('stream-render'))
        metrics.end(metrics.start('chat-selection'))

        expect(reported.map(([name]) => name)).toEqual(['render-batch', 'chat-selection'])
        expect(reported.every(([, duration]) => Number.isFinite(duration) && duration >= 0)).toBe(true)
    })
})
