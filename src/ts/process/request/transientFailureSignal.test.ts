import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { ModelPresetAdapterError, deriveHttpAdapterError } from '../../preset/adapter/error'
import { presetFailureRetryPolicy } from './responseRetryPolicy'
import { derivePluginFailureSignal } from './pluginRequestEvidence'

/**
 * The transient-failure signal has to reach the caller as data. Sniffing "429"
 * out of the error prose would put a model's own output, or a provider's choice
 * of wording, in charge of whether the app waits.
 */
describe('http status and Retry-After reach the caller as data', () => {
    const errorResponse = (
        status: number,
        headers: Record<string, string> = {},
    ) => new Response(JSON.stringify({ error: { message: 'The upstream is rate limited' } }), {
        status,
        headers,
    })

    test('carries the status and the seconds form of Retry-After', async () => {
        const error = await deriveHttpAdapterError(
            errorResponse(429, { 'retry-after': '2' }),
        )
        expect(error.kind).toBe('rate-limit')
        expect(error.status).toBe(429)
        expect(error.retryAfterMs).toBe(2_000)
        expect(error.retryable).toBe(true)
    })

    test('carries the HTTP-date form of Retry-After', async () => {
        const at = new Date(Date.now() + 5_000).toUTCString()
        const error = await deriveHttpAdapterError(
            errorResponse(503, { 'retry-after': at }),
        )
        expect(error.status).toBe(503)
        // Second-resolution header against a millisecond clock.
        expect(error.retryAfterMs).toBeGreaterThan(3_500)
        expect(error.retryAfterMs).toBeLessThanOrEqual(5_000)
    })

    test('leaves Retry-After unset when the provider sent none', async () => {
        const error = await deriveHttpAdapterError(errorResponse(500))
        expect(error.status).toBe(500)
        expect(error.retryAfterMs).toBeUndefined()
    })

    test('never marks a rejected request retryable, header or not', async () => {
        for (const status of [400, 401, 403, 404]) {
            const error = await deriveHttpAdapterError(
                errorResponse(status, { 'retry-after': '2' }),
            )
            expect(error.status).toBe(status)
            expect(error.retryable).toBe(false)
        }
    })

    test('surfaces both onto the failed request response', () => {
        expect(presetFailureRetryPolicy(new ModelPresetAdapterError(
            'rate-limit',
            'The upstream is rate limited',
            { status: 429, retryAfterMs: 2_000 },
        ))).toEqual({
            noRetry: false,
            fallbackEligible: false,
            status: 429,
            retryAfterMs: 2_000,
        })
    })

    test('omits a status the transport never had', () => {
        expect(presetFailureRetryPolicy(new Error('Failed to fetch')))
            .toEqual({})
    })

    test('attaches the signal to the ModelPreset failure response', () => {
        const source = readFileSync('src/ts/process/request/request.ts', 'utf8')
        expect(source).toContain('...presetFailureRetryPolicy(err, abortSignal?.aborted),')
        expect(source).toContain('...derivePluginFailureSignal(error),')
    })

    test('keeps the classic retry loop from re-issuing a rate limit with no gap', () => {
        const source = readFileSync('src/ts/process/request/request.ts', 'utf8')
        expect(source).toContain(
            "else if(da.type === 'fail' && isRetryableModelStatus(da.status)){"
        )
        expect(source).toContain(
            'await abortableDelay(1000, abortSignal ?? undefined)'
        )
    })
})

/**
 * Plugin providers are third-party JavaScript and there is no `Response` to
 * read: only whatever the plugin threw.
 */
describe('plugin provider failure signal', () => {
    test('prefers the structured carriers a plugin actually throws', () => {
        expect(derivePluginFailureSignal(
            Object.assign(new Error('nope'), { status: 429 }),
        )).toEqual({ status: 429 })
        expect(derivePluginFailureSignal(
            Object.assign(new Error('nope'), { statusCode: 503 }),
        )).toEqual({ status: 503 })
        expect(derivePluginFailureSignal(
            Object.assign(new Error('nope'), {
                response: {
                    status: 429,
                    headers: new Headers({ 'retry-after': '7' }),
                },
            }),
        )).toEqual({ status: 429, retryAfterMs: 7_000 })
    })

    test('falls back to a status only at the very start of the message', () => {
        expect(derivePluginFailureSignal(new Error(
            '429 Too Many Requests {"error":{"type":"rate_limit_error"}}',
        ))).toEqual({ status: 429 })
        expect(derivePluginFailureSignal(new Error('HTTP 503 Service Unavailable')))
            .toEqual({ status: 503 })
    })

    test('does not read a status out of prose that merely mentions one', () => {
        // The narrow rule this documents: anything but a leading status token
        // is left alone, so model output and differently worded provider prose
        // can never decide that the app should wait.
        expect(derivePluginFailureSignal(new Error(
            'The upstream returned 429 Too Many Requests',
        ))).toEqual({})
        expect(derivePluginFailureSignal(new Error('rate limit exceeded')))
            .toEqual({})
        expect(derivePluginFailureSignal(new Error(
            'Model wrote: "the answer is 429" and stopped',
        ))).toEqual({})
        expect(derivePluginFailureSignal('429 Too Many Requests')).toEqual({})
    })

    test('ignores statuses that are not statuses', () => {
        expect(derivePluginFailureSignal(
            Object.assign(new Error('nope'), { status: 42 }),
        )).toEqual({})
        expect(derivePluginFailureSignal(new Error('200 OK but empty')))
            .toEqual({})
    })

    test('survives a plugin whose header bag throws', () => {
        expect(derivePluginFailureSignal(Object.assign(new Error('nope'), {
            status: 429,
            response: {
                status: 429,
                headers: {
                    get() { throw new Error('hostile') },
                },
            },
        }))).toEqual({ status: 429 })
    })
})
