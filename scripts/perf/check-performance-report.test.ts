import { expect, test } from 'vitest'
import { evaluatePerformanceReport, median, percentile95 } from './check-performance-report.mjs'

test('rejects reports outside the approved p95 thresholds', () => {
    const result = evaluatePerformanceReport({
        schemaVersion: 1,
        durations: {
            'first-interactive': [4_900, 5_100, 8_100],
            'chat-selection': [1_600],
            'render-batch': [60],
            'long-task': [120, 130, 140],
        },
        sessionDurationMs: 60_000,
        resources: [{ hydratedChats: 3, mountedMessages: 61, imageCacheBytes: 0 }],
    })
    expect(result.ok).toBe(false)
    expect(result.failures).toEqual(expect.arrayContaining([
        expect.stringContaining('first-interactive'),
        expect.stringContaining('hydratedChats'),
    ]))
})

test('uses the nearest-rank p95 and accepts values within limits', () => {
    expect(percentile95([1, 2, 3, 4, 5])).toBe(5)
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(evaluatePerformanceReport({
        durations: { 'first-interactive': [5_000], 'chat-selection': [1_500], 'render-batch': [50], 'long-task': [100] },
        sessionDurationMs: 60_000,
        resources: [{ hydratedChats: 2, mountedMessages: 60, imageCacheBytes: 0 }],
        schemaVersion: 1,
    })).toEqual({ ok: true, failures: [] })
})

test('rejects an empty report so a no-op exporter cannot satisfy the device gate', () => {
    expect(evaluatePerformanceReport({ schemaVersion: 1, durations: {}, resources: [], sessionDurationMs: 0 })).toEqual({
        ok: false,
        failures: expect.arrayContaining([
            'missing first-interactive samples',
            'missing chat-selection samples',
            'missing render-batch samples',
            'missing resource samples',
        ]),
    })
})
