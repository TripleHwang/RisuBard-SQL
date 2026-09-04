/**
 * Transient-failure retry policy for model requests.
 *
 * A rate-limited provider answers 429 to a burst of requests; a BardWiki reboot
 * is exactly such a burst (one model request per turn, hundreds of them, issued
 * as fast as they complete). Without a wait, one 429 fails the batch and the
 * whole reboot job with it.
 *
 * Everything here is pure and dependency-free so it can be shared by the
 * transport layer (which turns an HTTP response into a status) and by the
 * BardWiki client (which decides whether to wait and try again).
 */

/** The transient-failure signal carried out of the transport, when it has one. */
export interface ModelRetrySignal {
    /** HTTP status the provider answered with, when the transport saw one. */
    status?: number
    /** Provider-declared wait before the next attempt, in milliseconds. */
    retryAfterMs?: number
}

export interface ModelRetryPolicy {
    /** Total attempts, the first one included. */
    maxAttempts: number
    /** First backoff step; doubles per attempt. */
    baseDelayMs: number
    /** Ceiling for one single wait. */
    maxDelayMs: number
    /** Ceiling for all the waits of one request, added together. */
    totalBudgetMs: number
}

/**
 * Four attempts, ~1s/2s/4s apart, at most 30s in any one wait and 60s of
 * waiting per request.
 *
 * - `maxAttempts: 4` — enough to ride out the short bursts a per-minute limit
 *   produces, few enough that a reboot of hundreds of turns cannot silently
 *   turn into hours of sleeping.
 * - `baseDelayMs: 1_000` — the smallest wait that is actually a wait for a
 *   per-minute quota; anything shorter is the hammering this exists to stop.
 * - `maxDelayMs: 30_000` — a longer single pause reads as a hang even with the
 *   progress line, and the caller can always resume.
 * - `totalBudgetMs: 60_000` — the budget is per request, not per job: the first
 *   request that exhausts it fails, which pauses the reboot in a resumable
 *   state instead of letting every remaining turn spend a minute waiting.
 */
export const DEFAULT_MODEL_RETRY_POLICY: ModelRetryPolicy = {
    maxAttempts: 4,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    totalBudgetMs: 60_000,
}

/**
 * Statuses worth trying again: 408 (the request timed out on the way),
 * 429 (rate limited) and 5xx (the provider is unwell). Everything else in 4xx
 * is a request the provider will reject identically forever -- retrying a 400
 * or a 401 spends the user's tokens and money on a request that cannot succeed.
 */
export function isRetryableModelStatus(status: unknown): boolean {
    if (typeof status !== 'number' || !Number.isFinite(status)) return false
    if (status === 408 || status === 429) return true
    return status >= 500 && status < 600
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1_000

/**
 * Parse an HTTP `Retry-After` header. RFC 9110 allows both forms:
 * a delay in seconds (`Retry-After: 2`) and an HTTP-date
 * (`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`).
 *
 * Returns milliseconds, or `undefined` when the header is absent or unparseable
 * -- never a negative wait, and never a value so large it is obviously junk.
 */
export function parseRetryAfterMs(
    value: string | null | undefined,
    nowMs: number = Date.now()
): number | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    if (trimmed.length === 0) return undefined
    if (/^\d+$/.test(trimmed)) {
        const seconds = Number(trimmed)
        if (!Number.isFinite(seconds)) return undefined
        const ms = seconds * 1_000
        return ms > MAX_RETRY_AFTER_MS ? MAX_RETRY_AFTER_MS : ms
    }
    // Every HTTP-date form carries a month and weekday name, so requiring a
    // letter keeps `Date.parse` from making something out of junk like "-5".
    if (!/[a-z]/i.test(trimmed)) return undefined
    const at = Date.parse(trimmed)
    if (!Number.isFinite(at)) return undefined
    const ms = at - nowMs
    if (!Number.isFinite(ms) || ms <= 0) return 0
    return ms > MAX_RETRY_AFTER_MS ? MAX_RETRY_AFTER_MS : ms
}

/**
 * How long to wait before attempt `attempt + 1`.
 *
 * A provider-declared `Retry-After` wins outright -- it is the only party that
 * knows when its window reopens. Otherwise exponential backoff with equal
 * jitter: half the step is fixed so the wait keeps growing, half is random so a
 * burst of requests that all hit the limit in the same second does not
 * resynchronise and hit the next window together.
 */
export function nextRetryDelayMs(input: {
    /** 1-based index of the attempt that just failed. */
    attempt: number
    retryAfterMs?: number
    policy?: ModelRetryPolicy
    random?: () => number
}): number {
    const policy = input.policy ?? DEFAULT_MODEL_RETRY_POLICY
    if (typeof input.retryAfterMs === 'number'
        && Number.isFinite(input.retryAfterMs)
        && input.retryAfterMs >= 0) {
        return Math.round(input.retryAfterMs)
    }
    const attempt = Math.max(1, Math.floor(input.attempt))
    const step = Math.min(
        policy.maxDelayMs,
        policy.baseDelayMs * 2 ** (attempt - 1)
    )
    const random = input.random ?? Math.random
    const jitter = Math.min(1, Math.max(0, random()))
    return Math.round(step / 2 + step * jitter / 2)
}

/**
 * `setTimeout` that gives up the moment the signal aborts, instead of after the
 * sleep finishes. A reboot's cancel button must stop a 30-second wait now.
 */
export function abortableDelay(
    ms: number,
    signal?: AbortSignal
): Promise<void> {
    if (signal?.aborted) {
        return Promise.reject(signal.reason ?? new Error('Aborted'))
    }
    if (!(ms > 0)) return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        function onAbort() {
            clearTimeout(timer)
            reject(signal?.reason ?? new Error('Aborted'))
        }
        signal?.addEventListener('abort', onAbort, { once: true })
    })
}

export interface ModelRetryNotice {
    /** 1-based index of the attempt that just failed. */
    attempt: number
    maxAttempts: number
    delayMs: number
    status?: number
    /** True when the wait came from the provider's own `Retry-After`. */
    fromRetryAfter: boolean
}

export interface ModelRetryRun<T> {
    /** Issues one attempt. `attempt` is 1-based. */
    run(attempt: number): Promise<T>
    /**
     * Returns the transient-failure signal when `value` is worth another
     * attempt, or `undefined` when it is a success or a permanent failure.
     */
    classify(value: T): ModelRetrySignal | undefined
    policy?: ModelRetryPolicy
    signal?: AbortSignal
    onRetry?(notice: ModelRetryNotice): void
    random?(): number
    sleep?(ms: number, signal?: AbortSignal): Promise<void>
}

/**
 * Run `run` until it succeeds, stops being retryable, or the caps are reached.
 *
 * The final failure is returned exactly as `run` produced it -- callers keep
 * reporting it the way they already do, which for a reboot means a paused,
 * resumable job rather than a hang.
 */
export async function runWithModelRetry<T>(
    options: ModelRetryRun<T>
): Promise<T> {
    const policy = options.policy ?? DEFAULT_MODEL_RETRY_POLICY
    const sleep = options.sleep ?? abortableDelay
    // Only the waiting is budgeted. The request's own duration is the caller's
    // concern (and already has its own deadlines); what must never grow without
    // bound is the time this function spends doing nothing.
    let waitedMs = 0
    for (let attempt = 1; ; attempt += 1) {
        options.signal?.throwIfAborted()
        const value = await options.run(attempt)
        const retrySignal = options.classify(value)
        if (!retrySignal) return value
        if (attempt >= policy.maxAttempts) return value
        options.signal?.throwIfAborted()
        const delayMs = nextRetryDelayMs({
            attempt,
            retryAfterMs: retrySignal.retryAfterMs,
            policy,
            random: options.random,
        })
        // A wait longer than the ceiling, or one that would spend more than the
        // per-request budget, is not worth taking: fail now and stay resumable.
        if (delayMs > policy.maxDelayMs) return value
        if (waitedMs + delayMs > policy.totalBudgetMs) return value
        waitedMs += delayMs
        options.onRetry?.({
            attempt,
            maxAttempts: policy.maxAttempts,
            delayMs,
            status: retrySignal.status,
            fromRetryAfter: typeof retrySignal.retryAfterMs === 'number',
        })
        await sleep(delayMs, options.signal)
    }
}
