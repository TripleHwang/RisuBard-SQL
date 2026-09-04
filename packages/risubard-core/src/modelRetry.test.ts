import { afterEach, describe, expect, test, vi } from 'vitest'
import {
    DEFAULT_MODEL_RETRY_POLICY,
    abortableDelay,
    isRetryableModelStatus,
    nextRetryDelayMs,
    parseRetryAfterMs,
    runWithModelRetry,
} from './modelRetry'

afterEach(() => {
    vi.useRealTimers()
})

describe('isRetryableModelStatus', () => {
    test('retries only the statuses that can succeed later', () => {
        for (const status of [408, 429, 500, 502, 503, 504, 599]) {
            expect(isRetryableModelStatus(status)).toBe(true)
        }
        for (const status of [200, 400, 401, 403, 404, 409, 422, 600, 0]) {
            expect(isRetryableModelStatus(status)).toBe(false)
        }
    })

    test('treats a missing status as not retryable', () => {
        expect(isRetryableModelStatus(undefined)).toBe(false)
        expect(isRetryableModelStatus('429')).toBe(false)
        expect(isRetryableModelStatus(Number.NaN)).toBe(false)
    })
})

describe('parseRetryAfterMs', () => {
    test('reads the delay-seconds form', () => {
        expect(parseRetryAfterMs('2')).toBe(2_000)
        expect(parseRetryAfterMs(' 30 ')).toBe(30_000)
        expect(parseRetryAfterMs('0')).toBe(0)
    })

    test('reads the HTTP-date form relative to now', () => {
        const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')
        expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:07 GMT', now))
            .toBe(7_000)
        // A date already in the past means "now", not a negative wait.
        expect(parseRetryAfterMs('Wed, 21 Oct 2015 07:27:00 GMT', now)).toBe(0)
    })

    test('returns nothing for an absent or unparseable header', () => {
        expect(parseRetryAfterMs(null)).toBeUndefined()
        expect(parseRetryAfterMs(undefined)).toBeUndefined()
        expect(parseRetryAfterMs('')).toBeUndefined()
        expect(parseRetryAfterMs('soon')).toBeUndefined()
        expect(parseRetryAfterMs('-5')).toBeUndefined()
    })

    test('bounds an absurd header instead of trusting it', () => {
        expect(parseRetryAfterMs('99999999')).toBe(24 * 60 * 60 * 1_000)
    })
})

describe('nextRetryDelayMs', () => {
    test('honours Retry-After over the backoff curve', () => {
        expect(nextRetryDelayMs({ attempt: 1, retryAfterMs: 2_000 }))
            .toBe(2_000)
        expect(nextRetryDelayMs({ attempt: 3, retryAfterMs: 0 })).toBe(0)
    })

    test('backs off exponentially and jitters within the step', () => {
        const low = (attempt: number) =>
            nextRetryDelayMs({ attempt, random: () => 0 })
        const high = (attempt: number) =>
            nextRetryDelayMs({ attempt, random: () => 1 })
        expect([low(1), high(1)]).toEqual([500, 1_000])
        expect([low(2), high(2)]).toEqual([1_000, 2_000])
        expect([low(3), high(3)]).toEqual([2_000, 4_000])
    })

    test('caps the backoff curve at the policy ceiling', () => {
        expect(nextRetryDelayMs({ attempt: 20, random: () => 1 }))
            .toBe(DEFAULT_MODEL_RETRY_POLICY.maxDelayMs)
    })
})

describe('abortableDelay', () => {
    test('resolves when the timer elapses', async () => {
        vi.useFakeTimers()
        const waited = abortableDelay(5_000)
        let settled = false
        void waited.then(() => { settled = true })
        await vi.advanceTimersByTimeAsync(4_999)
        expect(settled).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        await waited
        expect(settled).toBe(true)
    })

    test('rejects the moment the signal aborts, not after the sleep', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const waited = abortableDelay(30_000, controller.signal)
        const outcome = waited.then(() => 'resolved', () => 'rejected')
        await vi.advanceTimersByTimeAsync(10)
        controller.abort()
        await expect(outcome).resolves.toBe('rejected')
        // No timer is left behind to fire later.
        expect(vi.getTimerCount()).toBe(0)
    })

    test('rejects immediately for an already-aborted signal', async () => {
        await expect(abortableDelay(1_000, AbortSignal.abort()))
            .rejects.toBeDefined()
    })
})

describe('runWithModelRetry', () => {
    const rateLimited = { ok: false, status: 429 }
    const succeeded = { ok: true as const }

    test('returns the first success without waiting', async () => {
        const sleep = vi.fn(async () => {})
        await expect(runWithModelRetry({
            run: async () => succeeded,
            classify: () => undefined,
            sleep,
        })).resolves.toBe(succeeded)
        expect(sleep).not.toHaveBeenCalled()
    })

    test('stops at the attempt cap and returns the failure unchanged', async () => {
        const sleep = vi.fn(async () => {})
        const run = vi.fn(async () => rateLimited)
        await expect(runWithModelRetry({
            run,
            classify: (value) => value.ok ? undefined : { status: value.status },
            sleep,
            random: () => 0,
        })).resolves.toBe(rateLimited)
        expect(run).toHaveBeenCalledTimes(
            DEFAULT_MODEL_RETRY_POLICY.maxAttempts
        )
        expect(sleep).toHaveBeenCalledTimes(
            DEFAULT_MODEL_RETRY_POLICY.maxAttempts - 1
        )
    })

    test('gives up rather than waiting past the total budget', async () => {
        const sleep = vi.fn(async () => {})
        const run = vi.fn(async () => rateLimited)
        await runWithModelRetry({
            run,
            classify: () => ({ status: 429, retryAfterMs: 20_000 }),
            policy: {
                ...DEFAULT_MODEL_RETRY_POLICY,
                maxAttempts: 6,
                totalBudgetMs: 45_000,
            },
            sleep,
        })
        // 20s + 20s fits in 45s; the third wait would not.
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([20_000, 20_000])
        expect(run).toHaveBeenCalledTimes(3)
    })

    test('gives up rather than honouring a Retry-After past the ceiling', async () => {
        const sleep = vi.fn(async () => {})
        const run = vi.fn(async () => rateLimited)
        await runWithModelRetry({
            run,
            classify: () => ({ status: 429, retryAfterMs: 90_000 }),
            sleep,
        })
        expect(sleep).not.toHaveBeenCalled()
        expect(run).toHaveBeenCalledOnce()
    })

    test('reports every wait before taking it', async () => {
        const notices: unknown[] = []
        await runWithModelRetry({
            run: async () => rateLimited,
            classify: () => ({ status: 429, retryAfterMs: 3_000 }),
            sleep: async () => {},
            onRetry: (notice) => notices.push(notice),
        })
        expect(notices).toEqual([
            { attempt: 1, maxAttempts: 4, delayMs: 3_000, status: 429, fromRetryAfter: true },
            { attempt: 2, maxAttempts: 4, delayMs: 3_000, status: 429, fromRetryAfter: true },
            { attempt: 3, maxAttempts: 4, delayMs: 3_000, status: 429, fromRetryAfter: true },
        ])
    })

    test('aborts out of the wait instead of finishing it', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const run = vi.fn(async () => rateLimited)
        const outcome = runWithModelRetry({
            run,
            classify: () => ({ status: 429, retryAfterMs: 30_000 }),
            signal: controller.signal,
        }).then(() => 'resolved', (error) => error)
        await vi.advanceTimersByTimeAsync(0)
        expect(run).toHaveBeenCalledOnce()
        controller.abort()
        await expect(outcome).resolves.toBeDefined()
        await expect(outcome).resolves.not.toBe('resolved')
        await vi.advanceTimersByTimeAsync(60_000)
        expect(run).toHaveBeenCalledOnce()
    })
})
