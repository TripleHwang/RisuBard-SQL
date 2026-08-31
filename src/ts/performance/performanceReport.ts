/** Content-free, bounded diagnostics intended for manual performance gates. */
export type DurationMetric =
    | 'bootstrap-fetch' | 'bootstrap-json' | 'first-interactive'
    | 'character-hydration' | 'message-page-fetch' | 'sql-commit'
    | 'render-batch' | 'chat-selection' | 'long-task'
    /** One `auditSqlCompatibilityDatabase` pass, snapshot and diff together. */
    | 'compatibility-audit'
    /**
     * The forced synchronous layout in `updateChatBody`: one
     * `querySelectorAll` plus one `getBoundingClientRect` per mounted row.
     * Separated from `render-batch` because it is the part that blocks on
     * layout rather than the part that mounts components.
     */
    | 'chat-row-measure'

export type ResourceSample = {
    hydratedChats: number
    mountedMessages: number
    imageCacheBytes: number
}

/**
 * Memory counters, kept apart from `ResourceSample` because every one of them
 * can honestly be unknown.
 *
 * `null` means "this runtime did not tell us", never zero. `performance.memory`
 * is a Chromium extension; Safari and Firefox do not implement it, and a
 * report that wrote 0 there would say "this session used no heap" about the
 * exact platform -- iOS Safari -- the bounds in this project were chosen for.
 */
export type MemorySample = {
    /** `performance.memory.usedJSHeapSize`, or null where unavailable. */
    jsHeapUsedBytes: number | null
    /** `performance.memory.totalJSHeapSize`, or null where unavailable. */
    jsHeapTotalBytes: number | null
    /**
     * UTF-16 bytes of the fingerprint strings held by `compatibilityBaseline`,
     * or null before any baseline exists. This is the string payload only: the
     * Map overhead that holds them is not counted.
     */
    compatibilityBaselineBytes: number | null
    /** How many fingerprint strings that baseline holds, or null when there is none. */
    compatibilityBaselineEntries: number | null
    /**
     * How many of those strings the pass that produced this baseline carried
     * over from the one before it, rather than allocating again.
     *
     * `compatibilityBaselineEntries - compatibilityBaselineReusedEntries` is
     * what the last audit actually added to the heap for the next five seconds.
     * On an idle session that difference is zero; if a report shows it near
     * `compatibilityBaselineEntries` pass after pass, something is rewriting the
     * whole database between passes and the audit is the least of it.
     */
    compatibilityBaselineReusedEntries: number | null
}

export type PerformanceReport = {
    schemaVersion: 1
    sessionDurationMs: number
    durations: Partial<Record<DurationMetric, number[]>>
    /**
     * How many times each metric fired over the whole session, which
     * `durations` cannot say: it keeps only the last `sampleLimit` samples, so
     * a metric that ran 20,000 times and one that ran 100 look identical there.
     *
     * For anything on a per-render path this is the number that decides whether
     * a change helped. `chat-row-measure` at 0.5 ms is free at ten passes a
     * minute and is the whole main thread at sixty passes a second, and only
     * the count tells those apart. One integer per metric name, so it is
     * bounded by the enum.
     */
    counts: Partial<Record<DurationMetric, number>>
    resources: ResourceSample[]
    memory: MemorySample[]
}

export type PerformanceReporter = ReturnType<typeof createPerformanceReport>

const DEFAULT_SAMPLE_LIMIT = 100

function boundedLimit(value: number | undefined): number {
    return Number.isSafeInteger(value) && value! > 0 ? value! : DEFAULT_SAMPLE_LIMIT
}

function numeric(value: number): number {
    return Number.isFinite(value) ? value : 0
}

/**
 * Unknown stays unknown. A non-finite reading is not evidence of zero, and the
 * whole point of the memory sample is to be able to tell "we measured nothing"
 * apart from "we measured nothing being used".
 */
function numericOrNull(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function createPerformanceReport(options: { sampleLimit?: number } = {}) {
    const sampleLimit = boundedLimit(options.sampleLimit)
    let startedAt = globalThis.performance?.now?.() ?? Date.now()
    const durations = new Map<DurationMetric, number[]>()
    const counts = new Map<DurationMetric, number>()
    let resources: ResourceSample[] = []
    let memory: MemorySample[] = []

    const push = <T>(items: T[], value: T): T[] => [...items, value].slice(-sampleLimit)

    return {
        recordDuration(name: DurationMetric, value: number): void {
            durations.set(name, push(durations.get(name) ?? [], numeric(value)))
            counts.set(name, (counts.get(name) ?? 0) + 1)
        },
        recordResources(value: ResourceSample): void {
            resources = push(resources, {
                hydratedChats: numeric(value.hydratedChats),
                mountedMessages: numeric(value.mountedMessages),
                imageCacheBytes: numeric(value.imageCacheBytes),
            })
        },
        recordMemory(value: MemorySample): void {
            memory = push(memory, {
                jsHeapUsedBytes: numericOrNull(value.jsHeapUsedBytes),
                jsHeapTotalBytes: numericOrNull(value.jsHeapTotalBytes),
                compatibilityBaselineBytes: numericOrNull(value.compatibilityBaselineBytes),
                compatibilityBaselineEntries: numericOrNull(value.compatibilityBaselineEntries),
                compatibilityBaselineReusedEntries: numericOrNull(value.compatibilityBaselineReusedEntries),
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
                counts: Object.fromEntries(counts),
                resources: resources.map((sample) => ({ ...sample })),
                memory: memory.map((sample) => ({ ...sample })),
            }
        },
        clear(): void {
            durations.clear()
            counts.clear()
            resources = []
            memory = []
            startedAt = globalThis.performance?.now?.() ?? Date.now()
        },
    }
}

/** One bounded, content-free report for the active browser session. */
export const runtimePerformanceReport = createPerformanceReport()
let runtimeResources: ResourceSample = { hydratedChats: 0, mountedMessages: 0, imageCacheBytes: 0 }
const UNKNOWN_MEMORY: MemorySample = {
    jsHeapUsedBytes: null,
    jsHeapTotalBytes: null,
    compatibilityBaselineBytes: null,
    compatibilityBaselineEntries: null,
    compatibilityBaselineReusedEntries: null,
}
let runtimeMemory: MemorySample = { ...UNKNOWN_MEMORY }

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

/**
 * Merge memory counters from independent owners.
 *
 * A field left out keeps its previous value; a field explicitly set to `null`
 * records that it became unknown again, which is what a released baseline is.
 */
export function updateRuntimeMemory(value: Partial<MemorySample>): void {
    runtimeMemory = { ...runtimeMemory, ...value }
    runtimePerformanceReport.recordMemory(runtimeMemory)
}

/** Test-only reset; production reports intentionally span the browser session. */
export function resetRuntimePerformanceReportForTesting(): void {
    runtimeResources = { hydratedChats: 0, mountedMessages: 0, imageCacheBytes: 0 }
    runtimeMemory = { ...UNKNOWN_MEMORY }
    runtimePerformanceReport.clear()
}
