/**
 * Startup phase timings, logged once as a single line.
 *
 * The loading text is the only signal a user has for where startup time goes,
 * and it is a poor one: "Opening SQL Database..." covers the metadata request,
 * its transfer and parse, the rebuild into a Database, the compatibility
 * baseline, the patch-sync clone and the whole setDatabase migration. Measured
 * in isolation each is small, so when startup is slow the label cannot say
 * which part grew.
 *
 * Marks live here rather than inside loadData because the phases worth
 * separating are spread across the SQL bootstrap and the storage client, and
 * because marks placed inside a branch silently vanish on the paths that skip
 * it -- which is exactly what happened to the first version of this.
 */
let phases: string[] = []
let last = 0
let started = 0
let active = false

export function beginStartupPhases(): void {
    phases = []
    last = performance.now()
    started = last
    active = true
}

/** No-op before `beginStartupPhases`, so callers never need to check. */
export function markStartupPhase(label: string): void {
    if (!active) return
    const now = performance.now()
    phases.push(`${label} ${(now - last).toFixed(0)}ms`)
    last = now
}

export function reportStartupPhases(): void {
    if (!active) return
    active = false
    console.error(
        `[startup] total ${(performance.now() - started).toFixed(0)}ms — ${phases.join(', ')}`,
    )
}
