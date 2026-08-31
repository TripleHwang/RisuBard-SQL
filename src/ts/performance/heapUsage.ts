/**
 * JS heap, where the runtime is willing to say.
 *
 * `performance.memory` is a Chromium extension and nothing else implements it:
 * not Safari (so not iOS, which is the platform this project's bounds were
 * chosen for), not Firefox. The standardised replacement,
 * `performance.measureUserAgentSpecificMemory()`, is asynchronous and requires
 * cross-origin isolation (COOP/COEP), which this app does not have and cannot
 * adopt without breaking its own asset loading -- so it is not used here.
 *
 * Everything therefore returns `null` rather than `0` when the reading is not
 * available. A zero here would be read as "this session used no heap", and the
 * one platform where that lie would be told is the one where it matters most.
 */

export type JsHeapReading = {
    /** Bytes of live JS objects, or null where the runtime does not report it. */
    usedBytes: number | null
    /** Bytes the heap has reserved, or null where the runtime does not report it. */
    totalBytes: number | null
    /** True only when the runtime actually produced numbers. */
    supported: boolean
}

const UNSUPPORTED: JsHeapReading = { usedBytes: null, totalBytes: null, supported: false }

type ChromiumMemory = {
    usedJSHeapSize?: unknown
    totalJSHeapSize?: unknown
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * Best-effort, synchronous, and never throwing. Reading this must not be able
 * to affect loading, hydration or persistence, so every failure is "unknown".
 *
 * `source` exists so tests can pass a runtime that does and does not implement
 * the extension without mutating the real `globalThis.performance`.
 */
export function readJsHeap(source: unknown = safePerformance()): JsHeapReading {
    try {
        const memory = (source as { memory?: ChromiumMemory } | undefined)?.memory
        if (!memory || typeof memory !== 'object') return UNSUPPORTED
        const usedBytes = finiteOrNull(memory.usedJSHeapSize)
        const totalBytes = finiteOrNull(memory.totalJSHeapSize)
        if (usedBytes === null && totalBytes === null) return UNSUPPORTED
        return { usedBytes, totalBytes, supported: true }
    }
    catch {
        return UNSUPPORTED
    }
}

function safePerformance(): unknown {
    try { return globalThis.performance }
    catch { return undefined }
}

/** True when this runtime reports a JS heap at all. Reports must say so. */
export function jsHeapReportingSupported(): boolean {
    return readJsHeap().supported
}
