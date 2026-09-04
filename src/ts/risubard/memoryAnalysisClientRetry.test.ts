import { afterEach, describe, expect, test, vi } from 'vitest'
import {
    createStoredResponseMemoryAnalysis,
    type MemoryAnalysisModelResponse,
    type MemoryAnalysisRetryNotice,
} from './memoryAnalysisClient'

/**
 * These drive the real `requestMemoryModel` -- the chokepoint every BardWiki
 * model request goes through -- by way of the same `run()` entry point the
 * wiki reboot uses. Only the transport underneath is faked, and the waits are
 * fake-timed so nothing here actually sleeps.
 */
describe('transient model failure retry', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    const memoryStateResponse = () => new Response(JSON.stringify({
        schemaVersion: 1,
        facts: [],
        events: [],
        appliedOperationIds: [],
    }))

    const successResponse: MemoryAnalysisModelResponse = {
        type: 'success',
        result: JSON.stringify({ schemaVersion: 1, operations: [] }),
    }

    const rateLimited: MemoryAnalysisModelResponse = {
        type: 'fail',
        result: 'The upstream is rate limited',
        status: 429,
    }

    const analysisInput = {
        characterId: 'character',
        chatId: 'chat',
        messages: [{
            messageId: 'message-1',
            role: 'assistant' as const,
            content: 'The first turn establishes a durable fact.',
        }],
    }

    function createAnalysis(
        requestModel: () => Promise<MemoryAnalysisModelResponse>,
        onRetryNotice?: (notice: MemoryAnalysisRetryNotice) => void,
    ) {
        return createStoredResponseMemoryAnalysis({
            requestModel,
            fetchImpl: vi.fn(async () => memoryStateResponse()) as unknown as typeof fetch,
            createAuth: async () => 'test-jwt',
            onError: vi.fn(),
            ...(onRetryNotice ? { onRetryNotice } : {}),
        })
    }

    test('rides out a 429 and hands the caller the success', async () => {
        vi.useFakeTimers()
        const requestModel = vi.fn(async () =>
            requestModel.mock.calls.length === 1 ? rateLimited : successResponse
        )
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(0)
        expect(requestModel).toHaveBeenCalledOnce()

        await vi.advanceTimersByTimeAsync(5_000)
        await expect(settled).resolves.toBe('resolved')
        expect(requestModel).toHaveBeenCalledTimes(2)
    })

    test('waits the provider Retry-After rather than its own backoff', async () => {
        vi.useFakeTimers()
        const requestModel = vi.fn(async () =>
            requestModel.mock.calls.length === 1
                ? { ...rateLimited, retryAfterMs: 2_000 }
                : successResponse
        )
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(1_999)
        // The default first backoff step is 0.5s-1s, so a second attempt by now
        // would mean Retry-After had been ignored.
        expect(requestModel).toHaveBeenCalledOnce()

        await vi.advanceTimersByTimeAsync(1)
        await expect(settled).resolves.toBe('resolved')
        expect(requestModel).toHaveBeenCalledTimes(2)
    })

    test('reports every wait so the pause is not silent', async () => {
        vi.useFakeTimers()
        const notices: MemoryAnalysisRetryNotice[] = []
        const requestModel = vi.fn(async () =>
            requestModel.mock.calls.length === 1
                ? { ...rateLimited, retryAfterMs: 3_000 }
                : successResponse
        )
        const analysis = createAnalysis(
            requestModel,
            (notice) => notices.push(notice),
        )

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(3_000)
        await expect(settled).resolves.toBe('resolved')
        expect(notices).toEqual([{
            chatId: 'chat',
            attempt: 1,
            maxAttempts: 4,
            delayMs: 3_000,
            status: 429,
            fromRetryAfter: true,
        }])
    })

    test('never retries a request the provider rejected', async () => {
        vi.useFakeTimers()
        const requestModel = vi.fn(async (): Promise<MemoryAnalysisModelResponse> => ({
            type: 'fail',
            result: 'Invalid request body',
            status: 400,
        }))
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(120_000)
        await expect(settled).resolves.toMatchObject({
            message: 'Memory analysis model request failed: Invalid request body',
        })
        expect(requestModel).toHaveBeenCalledOnce()
    })

    test('never retries when the transport vetoed one', async () => {
        vi.useFakeTimers()
        const requestModel = vi.fn(async (): Promise<MemoryAnalysisModelResponse> => ({
            ...rateLimited,
            noRetry: true,
        }))
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(120_000)
        await expect(settled).resolves.toBeInstanceOf(Error)
        expect(requestModel).toHaveBeenCalledOnce()
    })

    test('stops at the attempt cap and fails the way it does today', async () => {
        vi.useFakeTimers()
        const requestModel = vi.fn(async () => rateLimited)
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(120_000)
        await expect(settled).resolves.toMatchObject({
            message:
                'Memory analysis model request failed: The upstream is rate limited',
        })
        expect(requestModel).toHaveBeenCalledTimes(4)
    })

    test('rides out a 503 the same way it rides out a 429', async () => {
        vi.useFakeTimers()
        const requestModel = vi.fn(async (): Promise<MemoryAnalysisModelResponse> =>
            requestModel.mock.calls.length === 1
                ? { type: 'fail', result: 'upstream unavailable', status: 503 }
                : successResponse
        )
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(5_000)
        await expect(settled).resolves.toBe('resolved')
        expect(requestModel).toHaveBeenCalledTimes(2)
    })

    test('never retries a request the provider refused to authorise', async () => {
        vi.useFakeTimers()
        const requestModel = vi.fn(async (): Promise<MemoryAnalysisModelResponse> => ({
            type: 'fail',
            result: 'Incorrect API key provided',
            status: 401,
        }))
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(120_000)
        await expect(settled).resolves.toMatchObject({
            message:
                'Memory analysis model request failed: Incorrect API key provided',
        })
        expect(requestModel).toHaveBeenCalledOnce()
    })

    test('never retries a blocked completion, which has no status at all', async () => {
        // The shape a content block arrives in: a fail the transport produced
        // from a 200 response, so there is no HTTP status to be retryable.
        vi.useFakeTimers()
        const requestModel = vi.fn(async (): Promise<MemoryAnalysisModelResponse> => ({
            type: 'fail',
            result: '응답에 금지된 문자 집합이 포함되어 생성에 실패했습니다.',
        }))
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(120_000)
        await expect(settled).resolves.toBeInstanceOf(Error)
        expect(requestModel).toHaveBeenCalledOnce()
    })

    test('issues exactly one request when nothing went wrong', async () => {
        vi.useFakeTimers()
        const requestModel = vi.fn(async () => successResponse)
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(120_000)
        await expect(settled).resolves.toBe('resolved')
        expect(requestModel).toHaveBeenCalledOnce()
    })

    test('abandons the wait the moment the caller cancels', async () => {
        vi.useFakeTimers()
        const controller = new AbortController()
        const requestModel = vi.fn(async () => ({
            ...rateLimited,
            retryAfterMs: 30_000,
        }))
        const analysis = createAnalysis(requestModel)

        const settled = analysis.run(analysisInput, controller.signal)
            .then(() => 'resolved', (error: unknown) => error)
        await vi.advanceTimersByTimeAsync(0)
        expect(requestModel).toHaveBeenCalledOnce()

        controller.abort()
        // No timer advance: cancelling has to settle the call now, not in 30s.
        // If the wait ran to completion this await would never return and the
        // test would time out.
        await settled
        expect(requestModel).toHaveBeenCalledOnce()
        await vi.advanceTimersByTimeAsync(120_000)
        expect(requestModel).toHaveBeenCalledOnce()
    })
})
