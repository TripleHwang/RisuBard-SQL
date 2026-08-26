import { describe, expect, it, vi } from 'vitest'
import { createRuntimeMetrics } from './runtimeMetrics'

describe('runtime metrics', () => {
    it('records fixed names only', () => {
        const marks: string[] = []
        const measure = vi.fn()
        const metrics = createRuntimeMetrics({ mark: name => { marks.push(name) }, measure })

        metrics.start('bootstrap')
        metrics.end('bootstrap')

        expect(marks).toEqual(['risu:bootstrap:start', 'risu:bootstrap:end'])
        expect(measure).toHaveBeenCalledWith('risu:bootstrap', 'risu:bootstrap:start', 'risu:bootstrap:end')
    })

    it('is safe when performance is absent or marks throw', () => {
        expect(() => createRuntimeMetrics(undefined).start('dirty-commit')).not.toThrow()
        const metrics = createRuntimeMetrics({ mark: () => { throw new Error('unsupported') }, measure: () => { throw new Error('unsupported') } })
        expect(() => { metrics.start('stream-render'); metrics.end('stream-render') }).not.toThrow()
    })
})
