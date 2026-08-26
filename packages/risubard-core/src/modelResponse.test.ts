import { describe, expect, it, vi } from 'vitest'
import { parseSingleJsonObject } from './modelOutput'
import { ModelOutputError, readModelResponseText, runValidatedModelRequest } from './modelResponse'

describe('model response quality', () => {
    it.each(['length', 'max_tokens', 'MAX_TOKENS', 'max_output_tokens'])
    ('rejects truncated output even if it contains valid JSON: %s', (finishReason) => {
        expect(() => readModelResponseText({ type: 'success', result: '{}', finishReason }))
            .toThrow(expect.objectContaining({ reason: 'truncated' }))
    })

    it.each(['', '   ', '<think>unfinished', '<Thoughts>only reasoning</Thoughts>'])
    ('rejects empty or reasoning-only responses: %s', (result) => {
        expect(() => readModelResponseText({ type: 'success', result }))
            .toThrow(expect.objectContaining({ reason: 'empty' }))
    })

    it('retains a complete answer and strips only leading reasoning', () => {
        expect(readModelResponseText({ type: 'success', result: '<think>draft</think>\n{"ok":true}', finishReason: 'stop' }))
            .toBe('{"ok":true}')
    })

    it('repairs invalid output once with typed feedback', async () => {
        const request = vi.fn(async (feedback?: ModelOutputError) => ({
            type: 'success', result: feedback ? '{"ok":true}' : 'not JSON',
        }))
        expect(await runValidatedModelRequest({ request, parse: parseSingleJsonObject }))
            .toEqual({ ok: true })
        expect(request).toHaveBeenCalledTimes(2)
        expect(request.mock.calls[1][0]).toBeInstanceOf(ModelOutputError)
    })

    it('stops after two invalid results without exposing model content', async () => {
        const request = vi.fn(async () => ({ type: 'success', result: 'private story text' }))
        await expect(runValidatedModelRequest({ request, parse: parseSingleJsonObject }))
            .rejects.toThrow('응답 형식')
        expect(request).toHaveBeenCalledTimes(2)
    })

    it('retries a typed output failure raised at the request boundary', async () => {
        const request = vi.fn(async (feedback?: ModelOutputError) => {
            if (!feedback) throw new ModelOutputError('truncated')
            return { type: 'success', result: '{"ok":true}' }
        })
        await expect(runValidatedModelRequest({ request, parse: parseSingleJsonObject }))
            .resolves.toEqual({ ok: true })
        expect(request).toHaveBeenCalledTimes(2)
    })

    it.each(['auth', 'aborted', 'rate limit'])('does not replay request failures: %s', async (message) => {
        const request = vi.fn(async () => { throw new Error(message) })
        await expect(runValidatedModelRequest({ request, parse: parseSingleJsonObject }))
            .rejects.toThrow(message)
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('does not retry failed responses or provider refusals', async () => {
        for (const response of [
            { type: 'fail', result: '인증 실패' },
            { type: 'success', result: '', finishReason: 'content_filter' },
            { type: 'success', result: '', finishReason: 'SAFETY' },
        ]) {
            const request = vi.fn(async () => response)
            await expect(runValidatedModelRequest({ request, parse: parseSingleJsonObject })).rejects.toThrow()
            expect(request).toHaveBeenCalledTimes(1)
        }
    })

    it.each([{ noRetry: true }, { toolExecuted: true }])
    ('never replays a result marked non-replayable: %s', async (flags) => {
        const request = vi.fn(async () => ({ type: 'success', result: 'not JSON', ...flags }))
        await expect(runValidatedModelRequest({ request, parse: parseSingleJsonObject })).rejects.toThrow()
        expect(request).toHaveBeenCalledTimes(1)
    })

    it('allows a batch owner to disable repair before splitting', async () => {
        const request = vi.fn(async () => ({ type: 'success', result: '{', finishReason: 'length' }))
        await expect(runValidatedModelRequest({ request, parse: parseSingleJsonObject, maxAttempts: 1 }))
            .rejects.toThrow(expect.objectContaining({ reason: 'truncated' }))
        expect(request).toHaveBeenCalledTimes(1)
    })
})
