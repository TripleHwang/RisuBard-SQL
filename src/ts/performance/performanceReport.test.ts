import { describe, expect, test } from 'vitest'
import {
    createPerformanceReport,
    recordRuntimeDuration,
    resetRuntimePerformanceReportForTesting,
    runtimePerformanceReport,
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
