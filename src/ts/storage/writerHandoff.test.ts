/**
 * The same-device single-writer protocol, driven the way the two tabs drive it.
 *
 * `globalApi.svelte.ts` cannot be imported in a test -- it pulls wasmoon and
 * DOMPurify and never finishes loading -- which is why the wiring around this is
 * asserted at source level in `metadataStartupWiring.test.ts`. The rule that
 * actually has to hold at runtime lives here instead, where it can be executed.
 */
import { describe, expect, it, vi } from 'vitest'

import { createWriterHandoff } from './writerHandoff'

/** Two handoffs joined by a channel that behaves like `BroadcastChannel`. */
function pairOfTabs() {
    const surrenders = { a: 0, b: 0 }
    let a: ReturnType<typeof createWriterHandoff>
    let b: ReturnType<typeof createWriterHandoff>
    // A real BroadcastChannel never echoes to its own sender.
    const postFromA = (sessionId: string) => b.receive(sessionId)
    const postFromB = (sessionId: string) => a.receive(sessionId)
    a = createWriterHandoff('tab-a', () => { surrenders.a += 1 })
    b = createWriterHandoff('tab-b', () => { surrenders.b += 1 })
    return {
        surrenders,
        aWrote: () => a.announce(postFromA),
        bWrote: () => b.announce(postFromB),
        a: () => a,
        b: () => b,
    }
}

describe('announcing a local write', () => {
    it('makes the other tab surrender', () => {
        const tabs = pairOfTabs()

        tabs.aWrote()

        expect(tabs.surrenders).toEqual({ a: 0, b: 1 })
        expect(tabs.b().surrendered).toBe(true)
        expect(tabs.a().surrendered).toBe(false)
    })

    /**
     * The regression this file exists for.
     *
     * In SQL mode the announcement is wired to `onSqlCommitSucceeded`, which
     * fires for every commit that reaches storage -- including the commits a tab
     * makes in the seconds between surrendering and the reload landing. If those
     * still went out, tab B would announce its way back at tab A, A would
     * surrender too, and a single edit in one tab would reload both. `saveDb`
     * could not do this because `triggerSave` returned early when it had
     * surrendered, before it ever reached the `postMessage`.
     */
    it('is silent once this tab has surrendered, so the two cannot evict each other', () => {
        const tabs = pairOfTabs()

        tabs.aWrote()
        // B is on its way to a reload, and its pending changes are still being
        // flushed. Not one of those flushes may reach A.
        tabs.bWrote()
        tabs.bWrote()

        expect(tabs.surrenders).toEqual({ a: 0, b: 1 })
        expect(tabs.a().surrendered).toBe(false)
    })

    it('ignores its own session id, so one tab cannot evict itself', () => {
        const surrender = vi.fn()
        const handoff = createWriterHandoff('tab-a', surrender)

        handoff.receive('tab-a')

        expect(surrender).not.toHaveBeenCalled()
        expect(handoff.surrendered).toBe(false)
    })

    it('keeps announcing while it is still the writer', () => {
        const posts: string[] = []
        const handoff = createWriterHandoff('tab-a', () => {})

        handoff.announce(id => posts.push(id))
        handoff.announce(id => posts.push(id))

        expect(posts).toEqual(['tab-a', 'tab-a'])
    })
})

describe('surrendering', () => {
    /**
     * `onSurrender` shows a blocking modal and then reloads. Both the channel
     * and the `risu-session-deactivated` listener (HTTP 423 from another device)
     * can fire more than once before that reload lands.
     */
    it('happens exactly once however many times it is triggered', () => {
        const surrender = vi.fn()
        const handoff = createWriterHandoff('tab-a', surrender)

        handoff.receive('tab-b')
        handoff.receive('tab-c')
        handoff.surrender()

        expect(surrender).toHaveBeenCalledTimes(1)
    })

    it('can be triggered without the channel, for a cross-device 423', () => {
        const surrender = vi.fn()
        const handoff = createWriterHandoff('tab-a', surrender)

        handoff.surrender()

        expect(surrender).toHaveBeenCalledTimes(1)
        expect(handoff.surrendered).toBe(true)
        handoff.announce(() => { throw new Error('a surrendered tab must not announce') })
    })
})
