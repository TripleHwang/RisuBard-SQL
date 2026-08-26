import { describe, expect, it, vi } from 'vitest'
import { ReclaimableCacheRegistry, SaverModeCoordinator } from './saverMode'

describe('SaverModeCoordinator', () => {
    it('flushes, evicts, shrinks the DOM, then clears caches in order', async () => {
        const calls: string[] = []
        const saver = new SaverModeCoordinator({
            flush: async () => { calls.push('flush') },
            evictChats: async () => { calls.push('evict') },
            setWindow: limit => calls.push(`window:${limit}`),
            clearCaches: () => calls.push('clear'),
        })

        await saver.enter('background')

        expect(calls).toEqual(['flush', 'evict', 'window:40', 'clear'])
        expect(saver.state).toBe('saver')
    })

    it('leaves state and later reclamation untouched when flushing fails', async () => {
        const calls: string[] = []
        const saver = new SaverModeCoordinator({
            flush: async () => { calls.push('flush'); throw new Error('offline') },
            evictChats: async () => { calls.push('evict') },
            setWindow: limit => calls.push(`window:${limit}`),
            clearCaches: () => calls.push('clear'),
        })

        await expect(saver.enter('background')).rejects.toThrow('offline')
        expect(calls).toEqual(['flush'])
        expect(saver.state).toBe('normal')
    })

    for (const failingStep of ['evict', 'window', 'clear'] as const) {
        it(`returns to normal and schedules a retry when ${failingStep} rejects`, async () => {
            const timers: Array<() => void> = []
            const actions = {
                flush: async () => undefined,
                evictChats: async () => undefined,
                setWindow: (_limit: 40 | 60) => undefined,
                clearCaches: () => undefined,
                setTimer: (callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout> },
                clearTimer: () => undefined,
            }
            if (failingStep === 'evict') actions.evictChats = async () => { throw new Error('evict') }
            if (failingStep === 'window') actions.setWindow = () => { throw new Error('window') }
            if (failingStep === 'clear') actions.clearCaches = () => { throw new Error('clear') }
            const saver = new SaverModeCoordinator(actions)

            await expect(saver.enter('background')).rejects.toThrow(failingStep)
            expect(saver.state).toBe('normal')
            expect(timers).toHaveLength(1)
        })
    }

    it('serializes overlapping transitions and only leaves after 30 visible focused seconds', async () => {
        let now = 0
        let visible = true
        let focused = true
        let scope = 0
        const windows: number[] = []
        const saver = new SaverModeCoordinator({
            flush: async () => undefined,
            evictChats: async () => undefined,
            setWindow: limit => windows.push(limit),
            clearCaches: () => undefined,
            now: () => now,
            isVisible: () => visible,
            isFocused: () => focused,
            scopeCount: () => scope,
        })

        await Promise.all([saver.enter('background'), saver.enter('cache-budget')])
        expect(await saver.tryLeave()).toBe(false)
        now = 29_999
        expect(await saver.tryLeave()).toBe(false)
        now = 30_000
        expect(await saver.tryLeave()).toBe(true)
        expect(windows).toEqual([40, 60])

        await saver.enter('background')
        scope = 1
        now += 31_000
        expect(await saver.tryLeave()).toBe(false)
        scope = 0
        visible = false
        now += 31_000
        expect(await saver.tryLeave()).toBe(false)
        visible = true
        focused = false
        now += 31_000
        expect(await saver.tryLeave()).toBe(false)
        focused = true
        now += 29_999
        expect(await saver.tryLeave()).toBe(false)
        now += 30_000
        expect(await saver.tryLeave()).toBe(true)
    })

    it('balances scopes when the operation rejects', async () => {
        const saver = new SaverModeCoordinator({ flush: async () => undefined, evictChats: async () => undefined, setWindow: () => undefined, clearCaches: () => undefined })

        await expect(saver.withScope('import', async () => { throw new Error('bad import') })).rejects.toThrow('bad import')
        expect(saver.scopeCount).toBe(0)
    })

    it('cancels a pending leave when a new pressure signal arrives', async () => {
        let now = 0
        const scheduled: Array<() => void> = []
        const saver = new SaverModeCoordinator({
            flush: async () => undefined, evictChats: async () => undefined, setWindow: () => undefined, clearCaches: () => undefined,
            now: () => now, setTimer: callback => { scheduled.push(callback); return scheduled.length as unknown as ReturnType<typeof setTimeout> }, clearTimer: () => undefined,
        })
        await saver.enter('background')
        now = 15_000
        await saver.enter('cache-budget')
        expect(scheduled).toHaveLength(2)
        now = 30_000
        expect(await saver.tryLeave()).toBe(false)
        now = 45_000
        expect(await saver.tryLeave()).toBe(true)
    })

    it('restores saver state and rearms leave when the normal DOM window fails', async () => {
        let now = 0
        const timers: Array<() => void> = []
        const windows: number[] = []
        const saver = new SaverModeCoordinator({
            flush: async () => undefined,
            evictChats: async () => undefined,
            setWindow: limit => {
                windows.push(limit)
                if (limit === 60) throw new Error('window restore failed')
            },
            clearCaches: () => undefined,
            now: () => now,
            setTimer: callback => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout> },
            clearTimer: () => undefined,
        })
        await saver.enter('background')
        now = 30_000
        await expect(saver.tryLeave()).rejects.toThrow('window restore failed')
        expect(saver.state).toBe('saver')
        expect(windows).toEqual([40, 60])
        expect(timers.length).toBeGreaterThan(1)
    })

    it('enters after two supported long tasks above 100ms in one minute', async () => {
        let now = 0
        const enter = vi.fn(async () => undefined)
        const saver = new SaverModeCoordinator({ flush: async () => undefined, evictChats: async () => undefined, setWindow: () => undefined, clearCaches: () => undefined, now: () => now })
        saver.enter = enter as typeof saver.enter
        saver.recordLongTask(101)
        now = 59_999
        saver.recordLongTask(101)
        await Promise.resolve()
        expect(enter).toHaveBeenCalledWith('long-task')
    })
})

describe('ReclaimableCacheRegistry', () => {
    it('clears every registered cache even when one owner throws', () => {
        const registry = new ReclaimableCacheRegistry()
        const second = vi.fn()
        registry.register(() => { throw new Error('bad owner') })
        registry.register(second)
        registry.clear()
        expect(second).toHaveBeenCalledOnce()
    })
})
