export type RuntimeMetricName =
    | 'bootstrap'
    | 'character-hydration'
    | 'message-page'
    | 'dirty-commit'
    | 'stream-render'

export type RuntimePerformanceApi = {
    mark(name: string): unknown
    measure(name: string, startMark?: string, endMark?: string): unknown
    clearMarks?(name?: string): unknown
}

export type RuntimeMetricHandle = Readonly<{
    name: RuntimeMetricName
    invocation: number
    startMark: string
}>

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
    let invocation = 0
    const mark = (name: string) => {
        try { api?.mark(name) } catch { /* optional browser API */ }
    }
    const measure = (name: string, start: string, end: string) => {
        try { api?.measure(name, start, end) } catch { /* optional browser API */ }
    }
    const clearMark = (name: string) => {
        try { api?.clearMarks?.(name) } catch { /* optional browser API */ }
    }
    const metric = (name: RuntimeMetricName) => `risu:${name}`
    return {
        start(name: RuntimeMetricName): RuntimeMetricHandle {
            const id = ++invocation
            const startMark = `${metric(name)}:start:${id}`
            mark(startMark)
            return { name, invocation: id, startMark }
        },
        end(handle: RuntimeMetricHandle): void {
            const base = metric(handle.name)
            const endMark = `${base}:end:${handle.invocation}`
            mark(endMark)
            measure(base, handle.startMark, endMark)
            clearMark(handle.startMark)
            clearMark(endMark)
        },
    }
}

export const runtimeMetrics = createRuntimeMetrics()
