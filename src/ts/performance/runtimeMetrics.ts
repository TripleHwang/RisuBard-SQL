export type RuntimeMetricName =
    | 'bootstrap'
    | 'character-hydration'
    | 'message-page'
    | 'dirty-commit'
    | 'stream-render'

export type RuntimePerformanceApi = {
    mark(name: string): unknown
    measure(name: string, startMark?: string, endMark?: string): unknown
}

function currentPerformance(): RuntimePerformanceApi | undefined {
    try {
        return globalThis.performance
    } catch {
        return undefined
    }
}

/**
 * Fixed, content-free performance marks for release profiling. Instrumentation
 * is strictly best-effort: unsupported SSR/WebKit APIs can never affect data
 * loading, hydration, or persistence.
 */
export function createRuntimeMetrics(api: RuntimePerformanceApi | undefined = currentPerformance()) {
    const mark = (name: string) => {
        try { api?.mark(name) } catch { /* optional browser API */ }
    }
    const measure = (name: string, start: string, end: string) => {
        try { api?.measure(name, start, end) } catch { /* optional browser API */ }
    }
    const metric = (name: RuntimeMetricName) => `risu:${name}`
    return {
        start(name: RuntimeMetricName): void {
            mark(`${metric(name)}:start`)
        },
        end(name: RuntimeMetricName): void {
            const base = metric(name)
            mark(`${base}:end`)
            measure(base, `${base}:start`, `${base}:end`)
        },
    }
}

export const runtimeMetrics = createRuntimeMetrics()
