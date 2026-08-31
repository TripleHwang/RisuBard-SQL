import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ModelPresetAdapterError } from '../../preset/adapter/error'
import { ModelOutputError } from '../../../../packages/risubard-core/src/modelResponse'
import { filterResponseCharacters, isRetryableTransportError, normalizeRequestRetryLimit, presetFailureRetryPolicy } from './responseRetryPolicy'

describe('bounded request retries', () => {
    it.each([NaN, Infinity, -1])('normalizes invalid retry count %s', (value) => {
        expect(normalizeRequestRetryLimit(value)).toBe(0)
    })
    it('honors finite settings within the existing UI limit', () => {
        expect(normalizeRequestRetryLimit(2)).toBe(2)
        expect(normalizeRequestRetryLimit(100)).toBe(20)
    })
    it('routes banned-script results through the normal bounded failure path', () => {
        expect(filterResponseCharacters({ type: 'success', result: 'hello 한글' }, ['Hangul']))
            .toMatchObject({ type: 'fail' })
    })
    it('does not replay tools or explicit no-retry results and tolerates invalid script settings', () => {
        for (const flags of [{ noRetry: true }, { toolExecuted: true }]) {
            const response = { type: 'success', result: '한글', ...flags }
            expect(filterResponseCharacters(response, ['Hangul'])).toBe(response)
        }
        expect(filterResponseCharacters({ type: 'success', result: 'hello' }, ['not-a-script']).type).toBe('success')
    })
    it.each(['auth', 'invalid-request', 'aborted', 'unsupported'] as const)('does not retry permanent failure %s', (kind) => {
        expect(presetFailureRetryPolicy(new ModelPresetAdapterError(kind, kind))).toEqual({ noRetry: true, fallbackEligible: false })
    })
    it('retains transient retry/fallback policy and abort overrides', () => {
        expect(presetFailureRetryPolicy(new ModelPresetAdapterError('server', 'server'))).toEqual({ noRetry: false, fallbackEligible: true })
        expect(presetFailureRetryPolicy(new Error('aborted'), true)).toEqual({ noRetry: true, fallbackEligible: false })
    })
    it('classifies thrown network and internal timeout failures as retryable', () => {
        expect(isRetryableTransportError(new TypeError('Failed to fetch'))).toBe(true)
        expect(isRetryableTransportError(new DOMException('Timed out', 'AbortError'))).toBe(true)
        expect(isRetryableTransportError(Object.assign(new Error('socket closed'), {
            code: 'ECONNRESET',
        }))).toBe(true)
    })
    it('does not classify user cancellation or unrelated exceptions as transport retries', () => {
        expect(isRetryableTransportError(
            new DOMException('Cancelled', 'AbortError'), true
        )).toBe(false)
        expect(isRetryableTransportError(new Error('Invalid request body'))).toBe(false)
    })
    it('preserves refusal-only decoupled stream no-retry classification', () => {
        expect(presetFailureRetryPolicy(new ModelOutputError('blocked'))).toEqual({ noRetry: true, fallbackEligible: false })
    })
    it('wires filtering into the shared request loop rather than an unconditional continue', () => {
        const source = readFileSync('src/ts/process/request/request.ts', 'utf8')
        expect(source.includes('da = filterResponseCharacters(')).toBe(true)
        expect(source.includes('trys > retryLimit')).toBe(true)
        expect(source.replace(/\r/g, '').includes('if(failed){\n                    continue')).toBe(false)
    })
    it('routes safe thrown transport failures through the shared bounded retry loop', () => {
        const source = readFileSync('src/ts/process/request/request.ts', 'utf8')
        expect(source).toContain('isRetryableTransportError')
        expect(source).toMatch(
            /try\s*\{\s*da = await requestChatDataMain\([\s\S]*?catch\(error\)[\s\S]*?tools\.length === 0[\s\S]*?failByServerError:\s*true/
        )
    })
    it('protects completed and interrupted decoupled streams from regeneration', () => {
        const source = readFileSync('src/ts/process/request/request.ts', 'utf8')
        expect(source.includes('noRetry: true, finishReason: streamFinishReason')).toBe(true)
        expect(source.includes('...(streamedOutputStarted ? { noRetry: true, fallbackEligible: false } : {})')).toBe(true)
    })
})
