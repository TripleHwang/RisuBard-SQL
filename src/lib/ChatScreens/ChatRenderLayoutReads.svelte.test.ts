import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Chats from './Chats.svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import {
    resetRuntimePerformanceReportForTesting,
    runtimePerformanceReport,
} from 'src/ts/performance/performanceReport'

/**
 * How many times one render reads layout.
 *
 * This is the quantity that decides what the chat screen costs per streamed
 * token, and it is the one the measurement phase got wrong by looking at the
 * wrong line. `getBoundingClientRect` is not expensive; the FIRST one taken
 * after the DOM has been written is, because it forces the browser to lay the
 * whole tree out synchronously before it can answer. Every later call in the
 * same turn is a cache hit at roughly zero. So the cost of a render is not "how
 * many rects" -- it is "did this render take a rect at all after touching the
 * DOM", and the answer used to be yes, unconditionally, on every effect run:
 * `checkIfAtBottom()` took two, and `updateChatBody` then measured all sixty
 * mounted rows.
 *
 * Neither read was needed on a streamed token. `checkIfAtBottom`'s answer is
 * consumed only when a message actually arrives at the newest end, which a
 * token never does -- it rewrites the last message in place. And the row
 * heights only feed `estimateSpacerHeight`, whose output cannot change while
 * the spacer counts and the mounted rows are both the same.
 *
 * These tests count layout reads rather than timing them, because happy-dom
 * has no layout to force: the count is the causal quantity and it is exact,
 * where a timing here would be a measurement of nothing.
 */

const OLDER_SENTINEL = '[data-chat-sentinel="older"]'

class RecordingIntersectionObserver {
    static live: RecordingIntersectionObserver[] = []
    targets = new Set<Element>()
    constructor(private readonly callback: IntersectionObserverCallback, readonly options?: IntersectionObserverInit) {
        RecordingIntersectionObserver.live.push(this)
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() {
        this.targets.clear()
        RecordingIntersectionObserver.live = RecordingIntersectionObserver.live.filter(observer => observer !== this)
    }
    takeRecords(): IntersectionObserverEntry[] { return [] }
    reportVisible(selector: string) {
        const target = [...this.targets].find(candidate => candidate.matches(selector))
        if (!target) throw new Error(`no observed element matches ${selector}`)
        this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
}

function scrollTo(selector: string) {
    const observer = RecordingIntersectionObserver.live.at(-1)
    if (!observer) throw new Error('the chat screen is not observing its scroll ends')
    observer.reportVisible(selector)
    flushSync()
}

function buildMessages(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        chatId: `m-${index}`,
        role: index % 2 === 0 ? 'user' : 'char',
        data: `message ${index}`,
    })) as any[]
}

function reactiveMessages(count: number): any[] {
    const messages = $state(buildMessages(count))
    return messages
}

function buildCharacter(messages: any[]) {
    return {
        chaId: 'character-1',
        name: 'Tester',
        type: 'character',
        image: '',
        chatPage: 0,
        chats: [{ id: 'chat-1', name: 'chat', note: '', localLore: [], message: messages }],
        alternateGreetings: [],
        firstMessage: 'hi',
        emotionImages: [],
        customscript: [],
        globalLore: [],
    } as any
}

let mounted: Record<string, any> | null = null
let host: HTMLDivElement | null = null
let renderedCharacter: any = null
let layoutReads = 0
let rectSpy: ReturnType<typeof vi.spyOn> | null = null

function render(messages: any[], extra: Record<string, unknown> = {}) {
    const currentCharacter = buildCharacter(messages)
    renderedCharacter = currentCharacter
    DBState.db.characters = [currentCharacter]
    selectedCharID.set(0)
    const scroller = document.createElement('div')
    host = document.createElement('div')
    host.appendChild(scroller)
    document.body.appendChild(host)
    mounted = mount(Chats, {
        target: scroller,
        props: {
            messages,
            currentCharacter,
            onReroll: () => {},
            unReroll: () => {},
            currentUsername: 'user',
            userIcon: '',
            ...extra,
        },
    }) as Record<string, any>
    flushSync()
    return scroller
}

/** Layout reads taken since the last call. */
function readsSince(): number {
    const taken = layoutReads
    layoutReads = 0
    return taken
}

function measurePasses(): number {
    return runtimePerformanceReport.export().counts['chat-row-measure'] ?? 0
}

beforeEach(() => {
    RecordingIntersectionObserver.live = []
    vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
    layoutReads = 0
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        layoutReads += 1
        return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
    })
    resetRuntimePerformanceReportForTesting()
    DBState.db.streamingDisplayOptimizationMode = 'balanced'
    DBState.db.autoScrollToNewMessage = true
    DBState.db.alwaysScrollToNewMessage = false
})

afterEach(() => {
    if (mounted) unmount(mounted)
    mounted = null
    host?.remove()
    host = null
    rectSpy?.mockRestore()
    rectSpy = null
    vi.unstubAllGlobals()
    resetRuntimePerformanceReportForTesting()
})

describe('the chat screen does not force a layout on every render', () => {
    it('reads no layout while a streaming message is being rewritten in place', () => {
        const messages = reactiveMessages(400)
        render(messages)
        renderedCharacter.chats[0].isStreaming = true
        flushSync()
        readsSince()
        const measuresBefore = measurePasses()

        // Twenty tokens. Each rewrites the last message and nothing else: no
        // row is added or removed, and neither spacer count moves.
        for (let token = 0; token < 20; token += 1) {
            messages[messages.length - 1].data = `streamed ${token}`
            flushSync()
        }

        expect(readsSince()).toBe(0)
        expect(measurePasses() - measuresBefore).toBe(0)
    })

    it('reads no layout when a rewritten row is remounted, which is what mode "off" does', () => {
        DBState.db.streamingDisplayOptimizationMode = 'off'
        const messages = reactiveMessages(400)
        const container = render(messages)
        readsSince()

        const before = container.querySelectorAll('[data-chat-row]').length
        for (let token = 0; token < 10; token += 1) {
            messages[messages.length - 1].data = `streamed ${token}`
            flushSync()
        }

        // The row really was remounted -- this is the expensive display mode --
        // and it still cost no layout read, because the set of mounted rows and
        // both spacer counts are what they were.
        expect(container.querySelectorAll('[data-chat-row]').length).toBe(before)
        expect(readsSince()).toBe(0)
    })

    it('re-measures the rows when the window slides, so the spacer is sized from what is on screen', () => {
        const container = render(reactiveMessages(400))
        readsSince()
        const measuresBefore = measurePasses()

        scrollTo(OLDER_SENTINEL)

        // A slide changes which rows are mounted and both spacer counts, so the
        // heights the spacer estimate is built from must be taken again.
        expect(readsSince()).toBeGreaterThan(0)
        expect(measurePasses() - measuresBefore).toBe(1)
        const before = container.querySelector('[data-chat-spacer="before"]') as HTMLElement
        const after = container.querySelector('[data-chat-spacer="after"]') as HTMLElement
        expect(before.style.height).not.toBe('')
        expect(after.style.height).not.toBe('')
    })

    it('re-measures when a message arrives, because the newest spacer count moved', () => {
        const messages = reactiveMessages(400)
        render(messages)
        // Scroll away so there is a non-zero spacer at the newest end for an
        // arrival to change.
        scrollTo(OLDER_SENTINEL)
        readsSince()
        const measuresBefore = measurePasses()

        messages.push({ chatId: 'm-new', role: 'char', data: 'arrived' })
        flushSync()

        expect(measurePasses() - measuresBefore).toBe(1)
    })

    /**
     * What the arrival path itself still does is covered in full by
     * `ChatNewMessageSignal.svelte.test.ts` -- including the one case that
     * consumes `checkIfAtBottom`'s answer, "scrolls instead of announcing when
     * the reader is already at the bottom". That suite is the regression net
     * for moving the call behind the arrival test; this one only asserts when
     * the call happens.
     */
    it('checks the scroll position exactly once when a message arrives, and never otherwise', () => {
        const messages = reactiveMessages(400)
        render(messages)
        readsSince()

        // Not an arrival: the last message is rewritten, not added.
        messages[messages.length - 1].data = 'rewritten'
        flushSync()
        expect(readsSince()).toBe(0)

        // An arrival at the newest end. `checkIfAtBottom` takes two rects, and
        // the re-measure takes one per mounted row; the point is that they are
        // paid here and not on the line above.
        messages.push({ chatId: 'm-new', role: 'char', data: 'arrived' })
        flushSync()
        expect(readsSince()).toBeGreaterThan(0)
    })
})
