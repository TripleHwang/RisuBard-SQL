import { describe, expect, test, vi } from 'vitest'
import { StreamFlushThrottle, pumpPresetStream, getPartialPresetStreamText, type StreamChunkController } from './presetStreamPump'
import type { AdapterChatStreamDelta } from 'src/ts/preset/adapter'

// --- StreamFlushThrottle (pure, injected clock) -----------------------------
//
// The throttle never touches real time or timers: onDelta/onTrailing/onEnd take
// `now` and read desiredSize through a closure, so flush decisions are fully
// deterministic here. The trailing-timer wiring is exercised by the pump tests.

function makeThrottle(initialDesiredSize: number | null = 1) {
    const enqueued: string[] = []
    let text = ''
    let desiredSize = initialDesiredSize
    const throttle = new StreamFlushThrottle(
        50,
        (chunk) => enqueued.push(chunk),
        () => text,
        () => desiredSize,
    )
    return {
        enqueued,
        throttle,
        append: (s: string) => { text += s },
        setDesiredSize: (n: number | null) => { desiredSize = n },
    }
}

describe('StreamFlushThrottle', () => {
    test('a refusal delta cannot be cleared by a later stop marker', async () => {
        const controller = makeController()
        await pumpPresetStream(genOf({ finishReason: 'refusal' }, { finishReason: 'stop' }), controller, {
            intervalMs: 50, formatReasoning: passthroughReasoning,
        })
        expect(controller.errored).toMatchObject({ reason: 'blocked', retryable: false })
    })
    test('flushes the first delta immediately regardless of clock', () => {
        const h = makeThrottle()
        h.append('a')
        expect(h.throttle.onDelta(1_000_000)).toBe(false)
        expect(h.enqueued).toEqual(['a'])
    })

    test('coalesces deltas within the interval into one flush', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // first -> flush 'a'
        h.append('b'); expect(h.throttle.onDelta(10)).toBe(true)  // <50ms -> pending
        h.append('c'); expect(h.throttle.onDelta(20)).toBe(true)  // still pending
        expect(h.enqueued).toEqual(['a'])
        h.append('d'); expect(h.throttle.onDelta(60)).toBe(false) // 60>=50 -> flush 'abcd'
        expect(h.enqueued).toEqual(['a', 'abcd'])
    })

    test('flushes the tail via onTrailing when the stream goes quiet (P1)', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a'
        h.append('b'); expect(h.throttle.onDelta(10)).toBe(true)  // pending 'ab'
        // no further deltas; the trailing timer fires
        expect(h.throttle.onTrailing(60)).toBe(false)
        expect(h.enqueued).toEqual(['a', 'ab'])
    })

    test('onEnd forces the final flush even under backpressure', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a'
        h.append('b'); h.throttle.onDelta(10)            // pending 'ab'
        h.setDesiredSize(0)                              // consumer full
        h.throttle.onEnd(20)
        expect(h.enqueued).toEqual(['a', 'ab'])
    })

    test('skips flushes under backpressure and emits only the latest on recovery (P2)', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a' (desiredSize 1)
        h.setDesiredSize(0)                              // consumer full
        h.append('b'); expect(h.throttle.onDelta(60)).toBe(true)   // interval ok but skipped
        h.append('c'); expect(h.throttle.onDelta(120)).toBe(true)  // still skipped
        expect(h.enqueued).toEqual(['a'])               // stale 'ab' never enqueued
        h.setDesiredSize(1)                             // consumer recovers
        expect(h.throttle.onTrailing(180)).toBe(false)  // flush latest only
        expect(h.enqueued).toEqual(['a', 'abc'])
    })

    test('keeps pending (requesting re-arm) while backpressure persists', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a'
        h.setDesiredSize(-1)
        h.append('b'); h.throttle.onDelta(60)            // skipped, pending
        expect(h.throttle.onTrailing(120)).toBe(true)    // still backpressured -> re-arm
        expect(h.throttle.onTrailing(180)).toBe(true)
        h.setDesiredSize(2)
        expect(h.throttle.onTrailing(240)).toBe(false)   // recovered -> flush
        expect(h.enqueued).toEqual(['a', 'ab'])
    })

    test('treats null desiredSize as no backpressure', () => {
        const h = makeThrottle(null)
        h.append('a'); expect(h.throttle.onDelta(0)).toBe(false)
        expect(h.enqueued).toEqual(['a'])
    })

    test('does not flush or duplicate when nothing is pending', () => {
        const h = makeThrottle()
        h.append('a'); h.throttle.onDelta(0)             // flush 'a', nothing pending
        expect(h.throttle.onTrailing(100)).toBe(false)
        h.throttle.onEnd(200)
        expect(h.enqueued).toEqual(['a'])
    })
})

// --- pumpPresetStream (integration with timers) -----------------------------

function makeController(desiredSize: number | null = 1) {
    const enqueued: Array<{ [key: string]: string }> = []
    const state = {
        enqueued,
        closed: false,
        errored: undefined as unknown,
        desiredSize,
        enqueue(chunk: { [key: string]: string }) { enqueued.push(chunk) },
        close() { state.closed = true },
        error(err: unknown) { state.errored = err },
    }
    return state
}

async function* genOf(
    ...deltas: Array<Partial<AdapterChatStreamDelta>>
): AsyncGenerator<AdapterChatStreamDelta, void, void> {
    for (const d of deltas) {
        yield { textDelta: '', raw: null, ...d }
    }
}

const passthroughReasoning = (t: string) => t

describe('pumpPresetStream', () => {
    test('recovers the cumulative answer after a real slow-consumer stream discards its queue on error', async () => {
        const failure = new Error('connection lost')
        const originalKeys = Object.getOwnPropertyNames(failure)
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        async function* interrupted(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
            yield { textDelta: 'a', raw: null }
            await gate
            yield { textDelta: 'b', raw: null }
            throw failure
        }
        let done!: Promise<void>
        const stream = new ReadableStream<{ [key: string]: string }>({
            start(controller) {
                done = pumpPresetStream(interrupted(), controller, {
                    intervalMs: 50, formatReasoning: passthroughReasoning,
                })
                return done
            },
        })
        const reader = stream.getReader()
        try {
            expect(await reader.read()).toEqual({ done: false, value: { '0': 'a' } })
            release()
            await done
            // Unlike a fake controller, error() drops the unread 'ab' snapshot.
            await expect(reader.read()).rejects.toBe(failure)
            expect(getPartialPresetStreamText).toBeTypeOf('function')
            expect(getPartialPresetStreamText(failure)).toBe('ab')
            expect(Object.getOwnPropertyNames(failure)).toEqual(originalKeys)
        } finally {
            release()
            reader.releaseLock()
        }
    })

    test('preserves the display snapshot without adding content to primitive failure diagnostics', async () => {
        const controller = makeController()
        async function* interrupted(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
            yield { textDelta: 'answer ', reasoningDelta: 'private reasoning', raw: null }
            throw 'private provider content'
        }
        await pumpPresetStream(interrupted(), controller, { intervalMs: 50, formatReasoning: (text) => `<Thoughts>${text}</Thoughts>` })
        expect(controller.errored).toBeInstanceOf(Error)
        expect((controller.errored as Error).message).not.toContain('private')
        expect(getPartialPresetStreamText(controller.errored)).toBe('<Thoughts>private reasoning</Thoughts>answer ')
        expect(JSON.stringify(controller.errored)).not.toContain('answer')
        expect(getPartialPresetStreamText('private provider content')).toBeUndefined()
        expect(getPartialPresetStreamText(null)).toBeUndefined()
    })

    test.each([
        { reasoningDelta: 'private reasoning' },
        { textDelta: '<think>private reasoning</think>' },
        { textDelta: 'blocked partial', finishReason: 'content_filter' },
    ])('does not recover empty, reasoning-only or blocked output (%j)', async (delta) => {
        const controller = makeController()
        await pumpPresetStream(genOf(delta), controller, { intervalMs: 50, formatReasoning: passthroughReasoning })
        expect(controller.errored).toBeInstanceOf(Error)
        expect(getPartialPresetStreamText).toBeTypeOf('function')
        expect(getPartialPresetStreamText(controller.errored)).toBeUndefined()
    })

    test.each(['onDelta', 'onFinish'] as const)('isolates a throwing %s observer from delivery', async (observer) => {
        const controller = makeController()
        const onDelta = vi.fn(() => { if (observer === 'onDelta') throw new Error('status unavailable') })
        const onFinish = vi.fn((..._args: unknown[]) => { if (observer === 'onFinish') throw new Error('status unavailable') })
        await expect(pumpPresetStream(genOf({ textDelta: 'answer', usage: { completionTokens: 3 } }), controller, {
            intervalMs: 50, formatReasoning: passthroughReasoning, onDelta, onFinish,
        })).resolves.toBeUndefined()
        expect(controller.enqueued.at(-1)).toEqual({ '0': 'answer' })
        expect(controller.closed).toBe(true)
        expect(controller.errored).toBeUndefined()
        expect(onFinish).toHaveBeenCalledTimes(1)
        expect(onFinish.mock.calls[0]).toEqual(['done', { completionTokens: 3 }, undefined])
    })

    test('isolates a throwing error observer and finalizes failure once', async () => {
        const controller = makeController()
        const failure = new Error('connection lost')
        const onFinish = vi.fn()
        async function* exploding(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
            yield { textDelta: 'partial', raw: null }
            throw failure
        }
        await expect(pumpPresetStream(exploding(), controller, {
            intervalMs: 50, formatReasoning: passthroughReasoning, onFinish,
            onError: () => { throw new Error('logger unavailable') },
        })).resolves.toBeUndefined()
        expect(controller.errored).toBe(failure)
        expect(controller.enqueued.at(-1)).toEqual({ '0': 'partial' })
        expect(onFinish).toHaveBeenCalledOnce()
        expect(onFinish.mock.calls[0][0]).toBe('failed')
    })

    test.each([
        [],
        [{ textDelta: '  ' }],
        [{ reasoningDelta: 'private reasoning', usage: { completionTokens: 7 } }],
        [{ textDelta: '<think>private reasoning</think>' }],
    ].map((deltas) => ({ deltas })))('rejects a stream with no final answer ($deltas)', async ({ deltas }) => {
        const controller = makeController()
        const onFinish = vi.fn()
        await pumpPresetStream(genOf(...deltas), controller, {
            intervalMs: 50, formatReasoning: passthroughReasoning, onFinish,
        })
        expect(controller.closed).toBe(false)
        expect(controller.errored).toMatchObject({ name: 'ModelOutputError', reason: 'empty' })
        expect((controller.errored as Error).message).not.toContain('private reasoning')
        expect(onFinish).toHaveBeenCalledOnce()
        expect(onFinish.mock.calls[0][0]).toBe('failed')
    })

    test('keeps useful limited output and reports merged usage and finish reason', async () => {
        const controller = makeController()
        const onFinish = vi.fn()
        await pumpPresetStream(genOf(
            { usage: { promptTokens: 20 } },
            { textDelta: 'partial answer' },
            { finishReason: 'length', usage: { completionTokens: 8 } },
            { usage: { reasoningTokens: 2 } },
        ), controller, { intervalMs: 50, formatReasoning: passthroughReasoning, onFinish })
        expect(controller.closed).toBe(true)
        expect(controller.enqueued.at(-1)).toEqual({ '0': 'partial answer' })
        expect(onFinish).toHaveBeenCalledExactlyOnceWith('done', {
            promptTokens: 20, completionTokens: 8, reasoningTokens: 2,
        }, 'length')
    })

    test('flushes pending partial text before reporting a transport failure', async () => {
        const controller = makeController(0)
        async function* exploding(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
            yield { textDelta: 'partial', raw: null }
            throw new Error('connection lost')
        }
        await pumpPresetStream(exploding(), controller, { intervalMs: 50, formatReasoning: passthroughReasoning })
        expect(controller.enqueued.at(-1)).toEqual({ '0': 'partial' })
        expect(controller.errored).toBeInstanceOf(Error)
    })

    test('handles trailing enqueue failures without an uncaught timer or double finish', async () => {
        vi.useFakeTimers()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        try {
            const controller = makeController()
            const onFinish = vi.fn()
            const failure = new Error('controller closed')
            async function* paused(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
                yield { textDelta: 'a', raw: null }
                yield { textDelta: 'b', raw: null }
                await gate
            }
            const done = pumpPresetStream(paused(), controller, {
                intervalMs: 50, formatReasoning: passthroughReasoning, onFinish,
            })
            await vi.advanceTimersByTimeAsync(1)
            controller.enqueue = () => { throw failure }
            await expect(vi.advanceTimersByTimeAsync(60)).resolves.toBe(vi)
            expect(vi.getTimerCount()).toBe(0)
            expect(controller.errored).toBe(failure)
            expect(onFinish).toHaveBeenCalledOnce()
            release()
            await done
            expect(onFinish).toHaveBeenCalledOnce()
        } finally {
            release()
            vi.useRealTimers()
        }
    })

    test('cancels a paused backpressured stream without leaving a timer or emitting later text', async () => {
        vi.useFakeTimers()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        try {
            const abort = new AbortController()
            const controller = makeController(0)
            const onFinish = vi.fn()
            async function* paused(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
                yield { textDelta: 'a', raw: null }
                await gate
                yield { textDelta: 'must not appear', raw: null }
            }
            const done = pumpPresetStream(paused(), controller, {
                intervalMs: 50, formatReasoning: passthroughReasoning, onFinish, abortSignal: abort.signal,
            })
            await vi.advanceTimersByTimeAsync(1)
            expect(vi.getTimerCount()).toBe(1)
            abort.abort()
            await vi.advanceTimersByTimeAsync(1)
            expect(vi.getTimerCount()).toBe(0)
            expect(controller.errored).toMatchObject({ name: 'AbortError' })
            expect(getPartialPresetStreamText).toBeTypeOf('function')
            expect(getPartialPresetStreamText(controller.errored)).toBe('a')
            expect(onFinish).toHaveBeenCalledOnce()
            release()
            await done
            expect(controller.enqueued.some((chunk) => chunk['0'].includes('must not appear'))).toBe(false)
            expect(onFinish).toHaveBeenCalledOnce()
        } finally {
            release()
            vi.useRealTimers()
        }
    })

    test('pumps deltas through and closes, leaking no timer', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            await pumpPresetStream(genOf({ textDelta: 'a' }, { textDelta: 'b' }), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
            })
            // 'a' flushes immediately; 'b' coalesces and lands in the final flush
            expect(controller.enqueued).toEqual([{ '0': 'a' }, { '0': 'ab' }])
            expect(controller.closed).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    test('wraps reasoning via formatReasoning, separate from the answer text', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            await pumpPresetStream(
                genOf({ reasoningDelta: 'why' }, { textDelta: 'answer' }),
                controller,
                { intervalMs: 50, formatReasoning: (t) => `<R>${t}</R>` },
            )
            expect(controller.enqueued).toEqual([
                { '0': '<R>why</R>' },
                { '0': '<R>why</R>answer' },
            ])
        } finally {
            vi.useRealTimers()
        }
    })

    test('fires a trailing flush when the stream pauses mid-response', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            let release!: () => void
            const gate = new Promise<void>((r) => { release = r })
            async function* paused(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
                yield { textDelta: 'a', raw: null }
                yield { textDelta: 'b', raw: null }
                await gate
                yield { textDelta: 'c', raw: null }
            }
            const done = pumpPresetStream(paused(), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
            })
            // drain microtasks so the generator reaches `await gate`
            await vi.advanceTimersByTimeAsync(1)
            expect(controller.enqueued).toEqual([{ '0': 'a' }]) // 'b' still pending
            // trailing timer (armed at t=0, delay 50) fires -> flush 'ab'
            await vi.advanceTimersByTimeAsync(60)
            expect(controller.enqueued).toEqual([{ '0': 'a' }, { '0': 'ab' }])
            release()
            await done
            expect(controller.enqueued).toEqual([{ '0': 'a' }, { '0': 'ab' }, { '0': 'abc' }])
            expect(controller.closed).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    test('forces the final flush even when the consumer stays backpressured', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController(0) // always full
            await pumpPresetStream(genOf({ textDelta: 'a' }, { textDelta: 'b' }), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
            })
            // every throttled flush skipped; onEnd forces the latest snapshot out
            expect(controller.enqueued).toEqual([{ '0': 'ab' }])
            expect(controller.closed).toBe(true)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    test('routes generator errors to controller.error and onError, clearing timers', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController(0) // backpressure -> a trailing timer is armed before the throw
            const onError = vi.fn()
            const boom = new Error('aborted mid-stream')
            async function* exploding(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
                yield { textDelta: 'a', raw: null }
                throw boom
            }
            await pumpPresetStream(exploding(), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
                onError,
            })
            expect(controller.errored).toBe(boom)
            expect(onError).toHaveBeenCalledWith(boom)
            expect(controller.closed).toBe(false)
            expect(vi.getTimerCount()).toBe(0) // catch cleared the armed trailing timer
        } finally {
            vi.useRealTimers()
        }
    })

    test('onDelta observes every raw delta, before throttling', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            const seen: Array<Partial<AdapterChatStreamDelta>> = []
            await pumpPresetStream(
                genOf({ reasoningDelta: 'why' }, { textDelta: 'a' }, { textDelta: 'b' }),
                controller,
                {
                    intervalMs: 50,
                    formatReasoning: passthroughReasoning,
                    onDelta: (d) => seen.push({ reasoningDelta: d.reasoningDelta, textDelta: d.textDelta }),
                },
            )
            // onDelta fires once per delta even though 'a'/'b' coalesce into one flush.
            expect(seen).toEqual([
                { reasoningDelta: 'why', textDelta: '' },
                { reasoningDelta: undefined, textDelta: 'a' },
                { reasoningDelta: undefined, textDelta: 'b' },
            ])
        } finally {
            vi.useRealTimers()
        }
    })

    test('onFinish reports done with the last usage seen', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            const onFinish = vi.fn()
            await pumpPresetStream(
                genOf(
                    { textDelta: 'a' },
                    { textDelta: 'b', usage: { completionTokens: 7 } },
                ),
                controller,
                { intervalMs: 50, formatReasoning: passthroughReasoning, onFinish },
            )
            expect(onFinish).toHaveBeenCalledTimes(1)
            expect(onFinish).toHaveBeenCalledWith('done', { completionTokens: 7 }, undefined)
        } finally {
            vi.useRealTimers()
        }
    })

    test('onFinish reports failed when the stream throws', async () => {
        vi.useFakeTimers()
        try {
            const controller = makeController()
            const onFinish = vi.fn()
            async function* exploding(): AsyncGenerator<AdapterChatStreamDelta, void, void> {
                yield { textDelta: 'a', raw: null }
                throw new Error('boom')
            }
            await pumpPresetStream(exploding(), controller, {
                intervalMs: 50,
                formatReasoning: passthroughReasoning,
                onFinish,
            })
            expect(onFinish).toHaveBeenCalledTimes(1)
            expect(onFinish.mock.calls[0][0]).toBe('failed')
        } finally {
            vi.useRealTimers()
        }
    })
})
