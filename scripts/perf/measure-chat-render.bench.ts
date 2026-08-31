// @vitest-environment happy-dom
/**
 * How many times one chat render reads layout.
 *
 * The measurement phase established the price of a forced synchronous layout in
 * real Chromium -- 0.4-1.5 ms on a 1,500-5,300 node tree, and the reporting
 * user's own console says 33 ms on theirs -- and established that the whole of
 * it is paid by the FIRST layout read taken after the DOM has been written.
 * Every later `getBoundingClientRect` in the same turn is a cache hit at
 * roughly zero. So what decides the cost of a render is not how many rects it
 * takes; it is whether it takes any at all.
 *
 * That makes the count the causal quantity, and it is exact where a timing in
 * happy-dom would be a measurement of nothing: there is no layout here to
 * force. Multiply the "renders that forced a layout" column by the price above
 * and by the render rate to get the main-thread share -- which is what
 * `counts['chat-row-measure']` in a real session's performance report now
 * reports directly.
 *
 * Run with:
 *   npx vitest run --config vitest.config.perf.ts scripts/perf/measure-chat-render.bench.ts
 */
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'

import Chats from '../../src/lib/ChatScreens/Chats.svelte'
import { DBState, selectedCharID } from '../../src/ts/stores.svelte'
import {
    resetRuntimePerformanceReportForTesting,
    runtimePerformanceReport,
} from '../../src/ts/performance/performanceReport'
import { reactiveMessages } from './chatRenderProbe.svelte'

const OLDER_SENTINEL = '[data-chat-sentinel="older"]'

class RecordingIntersectionObserver {
    static live: RecordingIntersectionObserver[] = []
    targets = new Set<Element>()
    constructor(private readonly callback: IntersectionObserverCallback) {
        RecordingIntersectionObserver.live.push(this)
    }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() {
        this.targets.clear()
        RecordingIntersectionObserver.live = RecordingIntersectionObserver.live.filter(o => o !== this)
    }
    takeRecords(): IntersectionObserverEntry[] { return [] }
    reportVisible(selector: string) {
        const target = [...this.targets].find(candidate => candidate.matches(selector))
        if (!target) throw new Error(`no observed element matches ${selector}`)
        this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
}

let layoutReads = 0
/** Renders in which at least one layout read happened -- i.e. forced reflows. */
let rendersThatRead = 0
let readsAtRenderStart = 0
let mounted: Record<string, any> | null = null
let host: HTMLDivElement | null = null
let rectSpy: ReturnType<typeof vi.spyOn> | null = null

function beginRender(): void { readsAtRenderStart = layoutReads }
function endRender(): void { if (layoutReads > readsAtRenderStart) rendersThatRead += 1 }

function buildCharacter(messages: any[]) {
    return {
        chaId: 'character-1', name: '캐릭터', type: 'character', image: '',
        chatPage: 0,
        chats: [{ id: 'chat-1', name: '대화', note: '', localLore: [], message: messages }],
        alternateGreetings: [], firstMessage: '안녕', emotionImages: [],
        customscript: [], globalLore: [],
    } as any
}

function render(messages: any[]) {
    const currentCharacter = buildCharacter(messages)
    DBState.db.characters = [currentCharacter]
    selectedCharID.set(0)
    const scroller = document.createElement('div')
    host = document.createElement('div')
    host.appendChild(scroller)
    document.body.appendChild(host)
    mounted = mount(Chats, {
        target: scroller,
        props: {
            messages, currentCharacter,
            onReroll: () => {}, unReroll: () => {},
            currentUsername: '사용자', userIcon: '',
        },
    }) as Record<string, any>
    flushSync()
    return { scroller, currentCharacter }
}

const pending: string[] = []
function row(label: string, value: string): void { pending.push(`    ${label.padEnd(46)} ${value}`) }
function flushReport(): void {
    if (pending.length) process.stdout.write(`${pending.join('\n')}\n`)
    pending.length = 0
}

beforeEach(() => {
    RecordingIntersectionObserver.live = []
    vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
    layoutReads = 0
    rendersThatRead = 0
    rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function () {
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

const measurePasses = () => runtimePerformanceReport.export().counts['chat-row-measure'] ?? 0

describe('layout reads on the chat render path', () => {
    for (const mode of ['balanced', 'off'] as const) {
        it(`a 200-token stream, streamingDisplayOptimizationMode "${mode}"`, () => {
            DBState.db.streamingDisplayOptimizationMode = mode
            const messages = reactiveMessages(400)
            const { currentCharacter } = render(messages)
            if (mode === 'balanced') currentCharacter.chats[0].isStreaming = true
            flushSync()
            layoutReads = 0
            rendersThatRead = 0
            const measuresBefore = measurePasses()

            const TOKENS = 200
            for (let token = 0; token < TOKENS; token += 1) {
                beginRender()
                messages[messages.length - 1].data = `스트리밍 중 ${token}`
                flushSync()
                endRender()
            }

            pending.push(`\n  [${TOKENS}-token stream, mode "${mode}", 60-row window]`)
            row('renders', String(TOKENS))
            row('layout reads', String(layoutReads))
            row('renders that forced a layout', String(rendersThatRead))
            row('row-measure passes', String(measurePasses() - measuresBefore))
            row('layout reads per render', (layoutReads / TOKENS).toFixed(2))
            flushReport()
        })
    }

    it('twenty scroll steps back through the history', () => {
        const messages = reactiveMessages(400)
        render(messages)
        layoutReads = 0
        rendersThatRead = 0
        const measuresBefore = measurePasses()

        const STEPS = 20
        for (let step = 0; step < STEPS; step += 1) {
            beginRender()
            RecordingIntersectionObserver.live.at(-1)!.reportVisible(OLDER_SENTINEL)
            flushSync()
            endRender()
        }

        // Every one of these SHOULD read layout: the mounted rows and both
        // spacer counts move, so the spacer estimate is about to be applied to
        // a different window and has to be built from rows that are on screen.
        pending.push(`\n  [${STEPS} scroll steps, 60-row window]`)
        row('renders', String(STEPS))
        row('layout reads', String(layoutReads))
        row('renders that forced a layout', String(rendersThatRead))
        row('row-measure passes', String(measurePasses() - measuresBefore))
        flushReport()
    })

    it('twenty messages arriving at the newest end', () => {
        const messages = reactiveMessages(400)
        render(messages)
        layoutReads = 0
        rendersThatRead = 0
        const measuresBefore = measurePasses()

        const ARRIVALS = 20
        for (let arrival = 0; arrival < ARRIVALS; arrival += 1) {
            beginRender()
            messages.push({ chatId: `arrived-${arrival}`, role: 'char', data: `도착 ${arrival}` })
            flushSync()
            endRender()
        }

        pending.push(`\n  [${ARRIVALS} arrivals, 60-row window]`)
        row('renders', String(ARRIVALS))
        row('layout reads', String(layoutReads))
        row('renders that forced a layout', String(rendersThatRead))
        row('row-measure passes', String(measurePasses() - measuresBefore))
        flushReport()
    })
})
