import { describe, expect, test, vi } from 'vitest'
import { StreamRenderScheduler } from './streamRenderScheduler'

function createFrames() {
    let next = 0
    const callbacks = new Map<number, FrameRequestCallback>()
    return {
        request: vi.fn((callback: FrameRequestCallback) => {
            const id = ++next
            callbacks.set(id, callback)
            return id
        }),
        cancel: vi.fn((id: number) => callbacks.delete(id)),
        async run() {
            const current = [...callbacks.entries()]
            callbacks.clear()
            for (const [, callback] of current) callback(0)
            await Promise.resolve()
        },
    }
}

describe('StreamRenderScheduler', () => {
    test('flushes only the newest burst value in one animation frame', async () => {
        const frames = createFrames()
        const render = vi.fn()
        const scheduler = new StreamRenderScheduler(render, frames.request, frames.cancel)

        scheduler.schedule('a')
        scheduler.schedule('ab')
        scheduler.schedule('abc')

        expect(frames.request).toHaveBeenCalledOnce()
        await frames.run()
        expect(render).toHaveBeenCalledExactlyOnceWith('abc')
    })

    test('terminal flush waits for an asynchronous frame renderer and commits the latest value', async () => {
        const frames = createFrames()
        let resolveFirst: (() => void) | undefined
        const render = vi.fn((value: string) => value === 'partial'
            ? new Promise<void>(resolve => { resolveFirst = resolve })
            : undefined)
        const scheduler = new StreamRenderScheduler(render, frames.request, frames.cancel)

        scheduler.schedule('partial')
        await frames.run()
        scheduler.schedule('final')
        const terminal = scheduler.flushNow()
        expect(render).toHaveBeenCalledExactlyOnceWith('partial')
        resolveFirst?.()
        await terminal

        expect(render.mock.calls).toEqual([['partial'], ['final']])
        expect(frames.cancel).toHaveBeenCalledOnce()
    })

    test('flushes terminal content when the stream ends before a frame runs', async () => {
        const frames = createFrames()
        const render = vi.fn()
        const scheduler = new StreamRenderScheduler(render, frames.request, frames.cancel)

        scheduler.schedule('```ts\nconst answer = 42\n```')
        await scheduler.flushNow()
        await frames.run()

        expect(render).toHaveBeenCalledExactlyOnceWith('```ts\nconst answer = 42\n```')
    })

    test('cancels queued work and does not invoke later callbacks', async () => {
        const frames = createFrames()
        const render = vi.fn()
        const scheduler = new StreamRenderScheduler(render, frames.request, frames.cancel)

        scheduler.schedule('stale')
        scheduler.cancel()
        scheduler.schedule('ignored')
        await frames.run()

        expect(render).not.toHaveBeenCalled()
    })

    test('waits for an in-flight renderer before abort cleanup completes', async () => {
        const frames = createFrames()
        let resolveRender: (() => void) | undefined
        const render = vi.fn(() => new Promise<void>(resolve => { resolveRender = resolve }))
        const scheduler = new StreamRenderScheduler(render, frames.request, frames.cancel)

        scheduler.schedule('partial')
        await frames.run()
        const cleanup = scheduler.cancelAndWait()
        scheduler.schedule('ignored')
        resolveRender?.()
        await cleanup

        expect(render).toHaveBeenCalledExactlyOnceWith('partial')
    })

    test('stops future frames after a renderer error and reports it to terminal cleanup', async () => {
        const frames = createFrames()
        const failure = new Error('parse failed')
        const render = vi.fn(() => { throw failure })
        const scheduler = new StreamRenderScheduler(render, frames.request, frames.cancel)

        scheduler.schedule('bad')
        await frames.run()
        scheduler.schedule('later')

        await expect(scheduler.flushNow()).rejects.toBe(failure)
        expect(render).toHaveBeenCalledExactlyOnceWith('bad')
    })
})
