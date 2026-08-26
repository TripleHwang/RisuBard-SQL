export type StartupMetricMark =
    | 'bootstrap-fetch:start'
    | 'bootstrap-fetch:end'
    | 'bootstrap-json:end'
    | 'first-interactive'
    | 'character-hydration:start'
    | 'character-hydration:end'
    | 'message-page-fetch:start'
    | 'message-page-fetch:end'
    | 'sql-commit:start'
    | 'sql-commit:end'
    | 'render-batch:start'
    | 'render-batch:end'
    | 'sql-auth:start'
    | 'sql-auth:end'
    | 'sql-open:start'
    | 'sql-open:end'
    | 'bootstrap-rebuild:start'
    | 'bootstrap-rebuild:end'

import { recordRuntimeDuration, type DurationMetric } from './performanceReport'

const prefix = (name: string) => `risu:${name}`

function bestEffort(callback: () => void): void {
    try {
        callback()
    }
    catch {
        // Instrumentation must never affect application behavior.
    }
}

function getPerformance(): Performance | undefined {
    try {
        return globalThis.performance
    }
    catch {
        return undefined
    }
}

export function markPerformance(name: StartupMetricMark): void {
    const performance = getPerformance()
    if (!performance) return

    const markName = prefix(name)
    bestEffort(() => performance.clearMarks?.(markName))
    bestEffort(() => performance.mark(markName))
    if (name === 'first-interactive') {
        bestEffort(() => recordRuntimeDuration('first-interactive', performance.now()))
    }
}

function reportMetric(name: string): DurationMetric | undefined {
    const metrics: readonly DurationMetric[] = [
        'bootstrap-fetch', 'bootstrap-json', 'character-hydration',
        'message-page-fetch', 'sql-commit', 'render-batch', 'sql-auth', 'sql-open', 'bootstrap-rebuild',
    ]
    return metrics.find((metric) => metric === name)
}

export function measurePerformance(
    name: string,
    start: StartupMetricMark,
    end?: StartupMetricMark,
): PerformanceMeasure | null {
    try {
        const performance = getPerformance()
        if (!performance) return null
        const measureName = prefix(name)
        const startName = prefix(start)
        const endName = end === undefined ? undefined : prefix(end)
        const measure = endName === undefined
            ? performance.measure(prefix(name), prefix(start))
            : performance.measure(measureName, startName, endName)

        bestEffort(() => performance.clearMeasures?.(measureName))
        const metric = reportMetric(name)
        if (metric) bestEffort(() => recordRuntimeDuration(metric, measure.duration))
        return measure
    }
    catch {
        return null
    }
}

export function observeLongTasks(callback: (entry: PerformanceEntry) => void): { disconnect: () => void } {
    try {
        if (typeof globalThis.PerformanceObserver !== 'function') {
            return { disconnect: () => undefined }
        }

        const observer = new globalThis.PerformanceObserver((entries) => {
            for (const entry of entries.getEntries()) {
                if (entry.duration > 100) {
                    bestEffort(() => recordRuntimeDuration('long-task', entry.duration))
                    bestEffort(() => callback(entry))
                }
            }
        })
        observer.observe({ type: 'longtask', buffered: true })
        return {
            disconnect: () => {
                try {
                    observer.disconnect()
                }
                catch {
                    // Disconnect is best-effort for partial observer implementations.
                }
            },
        }
    }
    catch {
        return { disconnect: () => undefined }
    }
}
