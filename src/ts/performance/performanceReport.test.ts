import { describe, expect, test } from 'vitest'
import {
    createPerformanceReport,
    recordRuntimeDuration,
    resetRuntimePerformanceReportForTesting,
    runtimePerformanceReport,
    updateRuntimeMemory,
    updateRuntimeResources,
} from './performanceReport'

describe('performance report', () => {
    test('bounds samples and exports only approved numeric fields', () => {
        const report = createPerformanceReport({ sampleLimit: 100 })
        for (let index = 0; index < 125; index++) report.recordDuration('bootstrap-fetch', index)
        report.recordDuration('long-task', 120)
        report.recordResources({ hydratedChats: 2, mountedMessages: 60, imageCacheBytes: 1024 })

        const exported = report.export()
        expect(exported.durations['bootstrap-fetch']).toHaveLength(100)
        expect(exported.durations['bootstrap-fetch']?.[0]).toBe(25)
        expect(JSON.stringify(exported)).not.toContain('messageText')
        expect(Object.keys(exported.resources[0])).toEqual(['hydratedChats', 'mountedMessages', 'imageCacheBytes'])
    })

    test('normalizes invalid numeric values so JSON stays portable', () => {
        const report = createPerformanceReport()
        report.recordDuration('sql-commit', Number.NaN)
        report.recordResources({ hydratedChats: Infinity, mountedMessages: 1, imageCacheBytes: -Infinity })

        expect(report.export()).toMatchObject({
            durations: { 'sql-commit': [0] },
            resources: [{ hydratedChats: 0, mountedMessages: 1, imageCacheBytes: 0 }],
        })
    })

    test('exposes one resettable shared content-free runtime report', () => {
        resetRuntimePerformanceReportForTesting()
        recordRuntimeDuration('chat-selection', 12)
        expect(runtimePerformanceReport.export().durations).toEqual({ 'chat-selection': [12] })
        resetRuntimePerformanceReportForTesting()
    })

    test('counts every occurrence, not only the samples it kept', () => {
        const report = createPerformanceReport({ sampleLimit: 10 })
        for (let index = 0; index < 4_000; index++) report.recordDuration('chat-row-measure', 0.4)
        report.recordDuration('compatibility-audit', 4)

        const exported = report.export()
        // The distinction the count exists for: a bounded sample array cannot
        // tell 4,000 forced layouts apart from ten.
        expect(exported.durations['chat-row-measure']).toHaveLength(10)
        expect(exported.counts['chat-row-measure']).toBe(4_000)
        expect(exported.counts['compatibility-audit']).toBe(1)
        expect(exported.counts['sql-commit']).toBeUndefined()
    })

    test('records an unknown heap as null rather than as zero', () => {
        const report = createPerformanceReport()
        report.recordMemory({
            jsHeapUsedBytes: null,
            jsHeapTotalBytes: Number.NaN,
            compatibilityBaselineBytes: 1024,
            compatibilityBaselineEntries: 4,
            compatibilityBaselineReusedEntries: null,
        })

        // The distinction this asserts is the whole reason `memory` is separate
        // from `resources`: on Safari there is no `performance.memory`, and a 0
        // here would read as "this session used no heap" on the one platform
        // whose limits these bounds were chosen for.
        expect(report.export().memory).toEqual([{
            jsHeapUsedBytes: null,
            jsHeapTotalBytes: null,
            compatibilityBaselineBytes: 1024,
            compatibilityBaselineEntries: 4,
            compatibilityBaselineReusedEntries: null,
        }])
    })

    test('bounds memory samples like every other sample series', () => {
        const report = createPerformanceReport({ sampleLimit: 10 })
        for (let index = 0; index < 25; index++) {
            report.recordMemory({
                jsHeapUsedBytes: index,
                jsHeapTotalBytes: index,
                compatibilityBaselineBytes: index,
                compatibilityBaselineEntries: index,
                compatibilityBaselineReusedEntries: index,
            })
        }
        const memory = report.export().memory
        expect(memory).toHaveLength(10)
        expect(memory[0].jsHeapUsedBytes).toBe(15)
    })

    test('merges memory counters and keeps fields nobody updated', () => {
        resetRuntimePerformanceReportForTesting()
        updateRuntimeMemory({
            compatibilityBaselineBytes: 2048,
            compatibilityBaselineEntries: 8,
            compatibilityBaselineReusedEntries: 8,
        })
        updateRuntimeMemory({ jsHeapUsedBytes: 500 })
        expect(runtimePerformanceReport.export().memory.at(-1)).toEqual({
            jsHeapUsedBytes: 500,
            jsHeapTotalBytes: null,
            compatibilityBaselineBytes: 2048,
            compatibilityBaselineEntries: 8,
            compatibilityBaselineReusedEntries: 8,
        })
        resetRuntimePerformanceReportForTesting()
        expect(runtimePerformanceReport.export().memory).toEqual([])
    })

    test('merges independent bounded resource counters without retaining data', () => {
        resetRuntimePerformanceReportForTesting()
        updateRuntimeResources({ hydratedChats: 2 })
        updateRuntimeResources({ mountedMessages: 60 })
        expect(runtimePerformanceReport.export().resources.at(-1)).toEqual({
            hydratedChats: 2,
            mountedMessages: 60,
            imageCacheBytes: 0,
        })
        resetRuntimePerformanceReportForTesting()
    })
})
