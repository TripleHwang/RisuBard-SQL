/** Content-free, bounded diagnostics intended for manual performance gates. */
export type DurationMetric =
    | 'bootstrap-fetch' | 'bootstrap-json' | 'first-visible-shell' | 'first-interactive'
    | 'character-hydration' | 'message-page-fetch' | 'sql-commit'
    | 'render-batch' | 'chat-selection' | 'long-task'
    | 'sql-auth' | 'sql-open' | 'bootstrap-rebuild'

export type ResourceSample = {
    hydratedChats: number
    mountedMessages: number
    imageCacheBytes: number
}

export type PerformanceReport = {
    schemaVersion: 1
    sessionDurationMs: number
    durations: Partial<Record<DurationMetric, number[]>>
    resources: ResourceSample[]
}

export type PerformanceReporter = ReturnType<typeof createPerformanceReport>

const DEFAULT_SAMPLE_LIMIT = 100

function boundedLimit(value: number | undefined): number {
    return Number.isSafeInteger(value) && value! > 0 ? value! : DEFAULT_SAMPLE_LIMIT
}

function numeric(value: number): number {
    return Number.isFinite(value) ? value : 0
}

export function createPerformanceReport(options: { sampleLimit?: number } = {}) {
    const sampleLimit = boundedLimit(options.sampleLimit)
    let startedAt = globalThis.performance?.now?.() ?? Date.now()
    const durations = new Map<DurationMetric, number[]>()
    let resources: ResourceSample[] = []

    const push = <T>(items: T[], value: T): T[] => [...items, value].slice(-sampleLimit)

    return {
        recordDuration(name: DurationMetric, value: number): void {
            durations.set(name, push(durations.get(name) ?? [], numeric(value)))
        },
        recordResources(value: ResourceSample): void {
            resources = push(resources, {
                hydratedChats: numeric(value.hydratedChats),
                mountedMessages: numeric(value.mountedMessages),
                imageCacheBytes: numeric(value.imageCacheBytes),
            })
        },
        export(): PerformanceReport {
            const now = globalThis.performance?.now?.() ?? Date.now()
            return {
                schemaVersion: 1,
                sessionDurationMs: Math.max(0, numeric(now - startedAt)),
                durations: Object.fromEntries(
                    [...durations].map(([name, samples]) => [name, [...samples]]),
                ),
                resources: resources.map((sample) => ({ ...sample })),
            }
        },
        clear(): void {
            durations.clear()
            resources = []
            startedAt = globalThis.performance?.now?.() ?? Date.now()
        },
    }
}

/** One bounded, content-free report for the active browser session. */
export const runtimePerformanceReport = createPerformanceReport()
let runtimeResources: ResourceSample = { hydratedChats: 0, mountedMessages: 0, imageCacheBytes: 0 }

export function recordRuntimeDuration(name: DurationMetric, value: number): void {
    runtimePerformanceReport.recordDuration(name, value)
}

export function recordRuntimeResources(value: ResourceSample): void {
    runtimePerformanceReport.recordResources(value)
}

/** Merge counters from independent runtime owners without retaining their data. */
export function updateRuntimeResources(value: Partial<ResourceSample>): void {
    runtimeResources = { ...runtimeResources, ...value }
    recordRuntimeResources(runtimeResources)
}

/** Test-only reset; production reports intentionally span the browser session. */
export function resetRuntimePerformanceReportForTesting(): void {
    runtimeResources = { hydratedChats: 0, mountedMessages: 0, imageCacheBytes: 0 }
    runtimePerformanceReport.clear()
}
