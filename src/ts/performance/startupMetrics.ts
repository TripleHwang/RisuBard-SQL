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
        bestEffort(() => performance.clearMarks?.(startName))
        if (endName !== undefined) bestEffort(() => performance.clearMarks?.(endName))
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
                if (entry.duration > 100) bestEffort(() => callback(entry))
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
