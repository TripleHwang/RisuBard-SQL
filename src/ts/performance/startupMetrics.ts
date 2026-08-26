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

function getPerformance(): Performance | undefined {
    try {
        return globalThis.performance
    }
    catch {
        return undefined
    }
}

export function markPerformance(name: StartupMetricMark): void {
    try {
        getPerformance()?.mark(prefix(name))
    }
    catch {
        // Some browser implementations expose Performance without mark support.
    }
}

export function measurePerformance(
    name: string,
    start: StartupMetricMark,
    end?: StartupMetricMark,
): PerformanceMeasure | null {
    try {
        const performance = getPerformance()
        if (!performance) return null
        return end === undefined
            ? performance.measure(prefix(name), prefix(start))
            : performance.measure(prefix(name), prefix(start), prefix(end))
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
                if (entry.duration > 100) callback(entry)
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
