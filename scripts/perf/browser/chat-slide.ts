/**
 * The same slide measured in real Chromium, where layout and paint exist.
 *
 * happy-dom can price the JavaScript half of a slide but not the half the
 * reporting user actually sees: it has no layout, so it cannot say how tall a
 * row is, and therefore cannot say how far a reader scrolls between two slides.
 * This page mounts the real `Chats.svelte` in a real scroller, autoscrolls it
 * the way a middle-click drag does, and records every frame.
 *
 * Served by the project's own dev server, so nothing here is built or
 * installed:
 *   npx vite
 *   http://localhost:5174/scripts/perf/browser/chat-slide.html
 *
 * Everything is driven from `window.__probe`; the page does nothing on its own
 * beyond mounting, so a driver can decide what to measure.
 */
import { flushSync, mount, unmount } from 'svelte'
import Chat from 'src/lib/ChatScreens/Chat.svelte'
import Chats from 'src/lib/ChatScreens/Chats.svelte'
import { setDatabase } from 'src/ts/storage/database.svelte'
import { createSimpleCharacter, DBState, selectedCharID } from 'src/ts/stores.svelte'
import { resetRuntimePerformanceReportForTesting, runtimePerformanceReport } from 'src/ts/performance/performanceReport'
import { koreanText } from '../koreanFixture'

const out = document.getElementById('out')!
const log = (text: string) => { out.textContent = `${out.textContent}\n${text}` }

function makeRandom(seed: number): () => number {
    let state = seed >>> 0 || 1
    return () => {
        state ^= state << 13; state >>>= 0
        state ^= state >>> 17
        state ^= state << 5; state >>>= 0
        return state / 0x1_0000_0000
    }
}

const random = makeRandom(20_260_904)
const MESSAGE_COUNT = Number(new URLSearchParams(location.search).get('messages') ?? 1_200)
const MESSAGE_LENGTH = Number(new URLSearchParams(location.search).get('length') ?? 400)
const SAVER = new URLSearchParams(location.search).get('saver') === '1'

const messages: any[] = Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
    chatId: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'char',
    data: koreanText(MESSAGE_LENGTH, random),
    time: 1_700_000_000_000 + index * 60_000,
    ...(index % 2 ? {
        generationInfo: {
            model: 'claude-sonnet-4', generationId: `gen-${index}`,
            inputTokens: 4_000 + index, outputTokens: 300 + (index % 200), maxContext: 200_000,
        },
    } : {}),
}))

setDatabase({} as any)
const currentCharacter: any = {
    chaId: 'character-1', name: '캐릭터', type: 'character', image: '',
    chatPage: 0,
    chats: [{ id: 'chat-1', name: '대화', note: '', localLore: [], message: messages }],
    alternateGreetings: [], firstMessage: '안녕', emotionImages: [],
    customscript: [], globalLore: [],
}
DBState.db.characters = [currentCharacter] as any
DBState.db.streamingDisplayOptimizationMode = 'off'
selectedCharID.set(0)

const scroller = document.getElementById('scroller')!
mount(Chats, {
    target: scroller,
    props: {
        messages: DBState.db.characters[0].chats[0].message as any,
        currentCharacter: DBState.db.characters[0] as any,
        saverMode: SAVER,
        onReroll: () => {}, unReroll: () => {},
        currentUsername: '사용자', userIcon: '',
    } as any,
})
flushSync()

const rowHost = () => (document.querySelector('[data-chat-row]')?.parentElement ?? null)
const rowHeights = () => Array.from(document.querySelectorAll('[data-chat-row]'))
    .map(element => (element as HTMLElement).getBoundingClientRect().height)

function stats(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    return {
        n: sorted.length,
        min: +(sorted[0] ?? 0).toFixed(2),
        median: +at(0.5).toFixed(2),
        p90: +at(0.9).toFixed(2),
        p99: +at(0.99).toFixed(2),
        max: +(sorted.at(-1) ?? 0).toFixed(2),
        mean: +(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1)).toFixed(2),
    }
}

/**
 * Autoscrolls at a constant pixel rate and records every frame, plus the frame
 * on which the mounted row set changed -- which is a slide, and the only thing
 * that can change it while nothing is being typed or streamed.
 */
async function run(options: { pxPerFrame: number, frames: number, direction: -1 | 1 }) {
    const host = rowHost()
    if (!host) throw new Error('no rows mounted')
    const slideFrames: number[] = []
    let frame = 0
    // Totals, not just which frames moved: spreading a slide over frames must
    // mount the same rows, not more of them. A version that mounted a row twice
    // would look smooth here and be doing double the work.
    let rowsAdded = 0
    let rowsRemoved = 0
    const observer = new MutationObserver(records => {
        let changed = 0
        for (const record of records) {
            changed += record.addedNodes.length + record.removedNodes.length
            rowsAdded += record.addedNodes.length
            rowsRemoved += record.removedNodes.length
        }
        if (changed > 0) slideFrames.push(frame)
    })
    observer.observe(host, { childList: true })

    const longTasks: number[] = []
    let longTaskObserver: PerformanceObserver | null = null
    try {
        longTaskObserver = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) longTasks.push(+entry.duration.toFixed(2))
        })
        longTaskObserver.observe({ entryTypes: ['longtask'] })
    } catch { /* not supported */ }

    const frameGaps: number[] = []
    const scrollAt: number[] = []
    // Read from the inline style, not from layout: the spacer height written by
    // `updateChatBody` is the number of interest, and asking for a rect every
    // frame would force a layout the scroll did not ask for.
    const beforeSpacer = document.querySelector('[data-chat-spacer="before"]') as HTMLElement
    const spacerAt: number[] = []
    // Sampled per frame because a frame that is slow with no long task on it is
    // not slow because of anything this page ran, and the heap dropping across
    // that frame is what says so.
    const heapAt: number[] = []
    const heapOf = () => (performance as any).memory?.usedJSHeapSize ?? 0
    let previous = performance.now()
    await new Promise<void>(resolve => {
        const step = () => {
            scroller.scrollBy(0, options.direction * options.pxPerFrame)
            requestAnimationFrame(() => {
                const stamp = performance.now()
                frameGaps.push(+(stamp - previous).toFixed(2))
                scrollAt.push(Math.round(scroller.scrollTop))
                spacerAt.push(Math.round(parseFloat(beforeSpacer.style.height) || 0))
                heapAt.push(heapOf())
                previous = stamp
                frame += 1
                if (frame >= options.frames) return resolve()
                step()
            })
        }
        step()
    })
    observer.disconnect()
    longTaskObserver?.disconnect()

    // Frames on which the row set changed, and what those frames cost.
    const unique = [...new Set(slideFrames)]
    const slideGaps = unique.map(index => frameGaps[index]).filter(value => Number.isFinite(value))
    const quietGaps = frameGaps.filter((_, index) => !unique.includes(index))
    const periods: number[] = []
    for (let i = 1; i < unique.length; i += 1) {
        periods.push(Math.abs(scrollAt[unique[i]] - scrollAt[unique[i - 1]]))
    }
    // What the slide did to the geometry above the viewport, and what the
    // browser's scroll anchoring did to the reader's position in response.
    const jumps = unique.map(index => ({
        frame: index,
        frameMs: frameGaps[index],
        spacerBefore: spacerAt[index - 1] ?? null,
        spacerAfter: spacerAt[index] ?? null,
        spacerDelta: (spacerAt[index] ?? 0) - (spacerAt[index - 1] ?? 0),
        // The scroll moved by `pxPerFrame` on purpose; anything on top of that
        // is the window slide dragging the reader.
        scrollDelta: (scrollAt[index] ?? 0) - (scrollAt[index - 1] ?? 0),
        unrequestedScroll: (scrollAt[index] ?? 0) - (scrollAt[index - 1] ?? 0) - options.direction * options.pxPerFrame,
    }))
    return {
        jumps,
        pxPerFrame: options.pxPerFrame,
        direction: options.direction,
        frames: options.frames,
        slides: unique.length,
        framesPerSlide: unique.length > 1
            ? +((unique.at(-1)! - unique[0]) / (unique.length - 1)).toFixed(1)
            : null,
        pxPerSlide: periods.length ? stats(periods) : null,
        slideFrameMs: slideGaps.length ? stats(slideGaps) : null,
        quietFrameMs: stats(quietGaps),
        // The number the reader actually feels: the worst frame in the run,
        // whatever caused it. A fix that spreads a slide over many frames looks
        // good in `slideFrameMs` for the wrong reason -- there are simply more
        // of them -- so this is what says whether the scroll ever stops.
        allFrameMs: stats(frameGaps),
        framesOver16ms: frameGaps.filter(value => value > 16).length,
        framesOver33ms: frameGaps.filter(value => value > 33).length,
        worstFrames: [...frameGaps].sort((a, b) => b - a).slice(0, 5),
        // Each slow frame with what the heap did across it. A frame that is
        // slow while the heap falls is a collection, not this page's work.
        slowFrames: frameGaps
            .map((ms, index) => ({ frame: index, ms, mutated: unique.includes(index), heapDeltaMB: +(((heapAt[index] ?? 0) - (heapAt[index - 1] ?? 0)) / 1e6).toFixed(1) }))
            .filter(entry => entry.ms > 16)
            .slice(0, 12),
        // How fast the run makes garbage, which is what sets the collection rate.
        heapGrowthPerFrameKB: heapAt.length > 1
            ? +(heapAt.slice(1).reduce((sum, value, index) => sum + Math.max(0, value - heapAt[index]), 0) / (heapAt.length - 1) / 1024).toFixed(1)
            : null,
        longTasks: longTasks.length ? stats(longTasks) : null,
        longTaskCount: longTasks.length,
        totalScrolled: Math.abs(scrollAt.at(-1)! - scrollAt[0]),
        rowsAdded,
        rowsRemoved,
    }
}

/**
 * Whether the content the reader is looking at moves by anything other than
 * the scroll they asked for.
 *
 * The spacer above the window is rewritten whenever a count changes, and the
 * estimate it is rewritten from moves as the mounted rows change, so the
 * geometry above the viewport is never still. None of that is allowed to reach
 * the reader: Chrome's scroll anchoring is supposed to absorb it entirely. The
 * only way to see whether it does is to watch one row that stays mounted right
 * through and ask how far it travelled on each frame -- which must be the
 * scroll that was requested, and nothing else.
 *
 * Reading its rect every frame forces a layout the scroll did not ask for, so
 * this is a diagnostic run, not a timing run.
 */
async function trackRow(options: { pxPerFrame: number, frames: number, direction: -1 | 1 }) {
    const rows = Array.from(document.querySelectorAll('[data-chat-row]')) as HTMLElement[]
    // A row in the middle of the window, so it survives as many slides as possible.
    const tracked = rows[Math.floor(rows.length / 2)]
    const id = tracked?.getAttribute('data-chat-row') ?? ''
    const movements: number[] = []
    const survivedFrames: number[] = []
    let previousTop: number | null = null
    let frame = 0
    await new Promise<void>(resolve => {
        const step = () => {
            scroller.scrollBy(0, options.direction * options.pxPerFrame)
            requestAnimationFrame(() => {
                const element = document.querySelector(`[data-chat-row="${id}"]`) as HTMLElement | null
                if (element) {
                    const top = element.getBoundingClientRect().top
                    if (previousTop !== null) movements.push(+(top - previousTop).toFixed(1))
                    previousTop = top
                    survivedFrames.push(frame)
                } else {
                    previousTop = null
                }
                frame += 1
                if (frame >= options.frames) return resolve()
                step()
            })
        }
        step()
    })
    // Every frame should move the tracked row by exactly the requested scroll.
    const expected = -options.direction * options.pxPerFrame
    const errors = movements.map(value => +(value - expected).toFixed(1))
    return {
        trackedRow: id,
        framesTracked: survivedFrames.length,
        expectedMovementPerFrame: expected,
        movement: movements.length ? stats(movements) : null,
        worstDeviationPx: errors.length ? Math.max(...errors.map(Math.abs)) : null,
        framesDeviatingOverOnePx: errors.filter(value => Math.abs(value) > 1).length,
    }
}

/**
 * The same three pieces `updateChatBody` does on a slide, timed on their own in
 * a real browser: the container, `mount(Chat)`, and `unmount` + `remove`. Also
 * the two costs a synchronous timer around `mount` cannot see -- the layout the
 * new rows force, and the asynchronous tail, because `ChatBody` parses its
 * markdown in a promise and writes it in with `{@html}` after the mount
 * returns.
 */
async function parts(count = 30, offset = 500) {
    const target = document.createElement('div')
    target.style.cssText = 'width:900px;position:absolute;left:-99999px;top:0'
    document.body.appendChild(target)
    const simple = createSimpleCharacter(DBState.db.characters[0] as any)
    const source = DBState.db.characters[0].chats[0].message as any[]
    const props = (index: number) => ({
        message: source[index].data, isLastMemory: false, idx: index,
        messageId: source[index].chatId, totalLength: source.length, img: '',
        onReroll: () => {}, onNextSwipe: () => {}, unReroll: () => {}, onDeleteSwipe: () => {},
        onConfirmMemory: async () => false, memoryConfirmed: false, canonicalReceipt: undefined,
        rerollIcon: false, character: simple, largePortrait: false,
        messageGenerationInfo: source[index].generationInfo, role: source[index].role,
        name: source[index].role === 'user' ? '사용자' : '캐릭터',
        isComment: false, disabled: false, isOptimizedStreamingMessage: false,
        streamingOptimizationMode: 'off', rawStreamingText: source[index].data,
    })

    const round = async (base: number) => {
        let mark = performance.now()
        const containers: HTMLDivElement[] = []
        for (let i = 0; i < count; i += 1) {
            const element = document.createElement('div')
            element.setAttribute('data-chat-row', `probe-${base + i}`)
            element.setAttribute('data-chat-id', `probe-${base + i}`)
            element.classList.add('chat-message-container')
            containers.push(element)
            target.appendChild(element)
        }
        const container = performance.now() - mark

        mark = performance.now()
        const instances = containers.map((element, i) => mount(Chat, { target: element, props: props(base + i) as any }))
        const mountMs = performance.now() - mark

        mark = performance.now()
        void target.getBoundingClientRect().height
        const layoutMs = performance.now() - mark

        // The markdown parse and its `{@html}` write land after the mount, in a
        // promise, so a timer around `mount` alone misses them entirely.
        mark = performance.now()
        await new Promise(resolve => setTimeout(resolve, 0))
        await new Promise(resolve => requestAnimationFrame(resolve))
        const tailMs = performance.now() - mark

        mark = performance.now()
        void target.getBoundingClientRect().height
        const layoutAfterTailMs = performance.now() - mark

        mark = performance.now()
        for (let i = 0; i < count; i += 1) { unmount(instances[i]); containers[i].remove() }
        const unmountMs = performance.now() - mark

        return { container, mountMs, layoutMs, tailMs, layoutAfterTailMs, unmountMs }
    }

    await round(offset) // warm
    const rounds: Array<Awaited<ReturnType<typeof round>>> = []
    for (let i = 0; i < 6; i += 1) rounds.push(await round(offset + 40 * (i + 1)))
    target.remove()
    const pick = (key: keyof (typeof rounds)[0]) => stats(rounds.map(entry => entry[key]))
    return {
        rows: count,
        container: pick('container'),
        mount: pick('mountMs'),
        layoutForcedByNewRows: pick('layoutMs'),
        asyncTailIncludingHtmlWrite: pick('tailMs'),
        layoutAfterTail: pick('layoutAfterTailMs'),
        unmountAndRemove: pick('unmountMs'),
    }
}

/**
 * What a slide's layout actually costs, as a function of how many rows it adds.
 *
 * `parts` above builds its rows in an empty container, so its layout figure is
 * the cost of laying out `count` rows from nothing. That answers a different
 * question from the one a smaller slide step asks, which is: with sixty rows
 * already resident and laid out, what does adding `k` more cost? If that is
 * proportional to `k`, a smaller step is a real reduction in blocked time; if
 * it is a constant, a smaller step just pays the constant more often.
 *
 * The rows are built detached and their markdown tail is awaited first, so the
 * timed section is the insertion and the layout it dirties -- nothing else.
 */
async function marginalLayout(k: number, rounds = 6) {
    const host = rowHost()
    if (!host) throw new Error('no rows mounted')
    const simple = createSimpleCharacter(DBState.db.characters[0] as any)
    const source = DBState.db.characters[0].chats[0].message as any[]
    const props = (index: number) => ({
        message: source[index].data, isLastMemory: false, idx: index,
        messageId: source[index].chatId, totalLength: source.length, img: '',
        onReroll: () => {}, onNextSwipe: () => {}, unReroll: () => {}, onDeleteSwipe: () => {},
        onConfirmMemory: async () => false, memoryConfirmed: false, canonicalReceipt: undefined,
        rerollIcon: false, character: simple, largePortrait: false,
        messageGenerationInfo: source[index].generationInfo, role: source[index].role,
        name: source[index].role === 'user' ? '사용자' : '캐릭터',
        isComment: false, disabled: false, isOptimizedStreamingMessage: false,
        streamingOptimizationMode: 'off', rawStreamingText: source[index].data,
    })

    const round = async (base: number) => {
        // Built and parsed off the document, so nothing in the timed section is
        // component construction.
        const staged = Array.from({ length: k }, (_, i) => {
            const element = document.createElement('div')
            element.setAttribute('data-probe-row', `probe-${base + i}`)
            element.classList.add('chat-message-container')
            return { element, instance: mount(Chat, { target: element, props: props(base + i) as any }) }
        })
        await new Promise(resolve => setTimeout(resolve, 30))
        await new Promise(resolve => requestAnimationFrame(resolve))

        // Layout is clean here; this is the floor the two numbers below stand on.
        let mark = performance.now()
        void host.getBoundingClientRect().height
        const cleanLayout = performance.now() - mark

        mark = performance.now()
        for (const row of staged) host.appendChild(row.element)
        const insert = performance.now() - mark

        mark = performance.now()
        void host.getBoundingClientRect().height
        const layoutAfterInsert = performance.now() - mark

        // What the shipped code does next: read every mounted row's height.
        mark = performance.now()
        const heights = Array.from(document.querySelectorAll('[data-chat-row]'))
            .map(element => (element as HTMLElement).getBoundingClientRect().height)
        const measureCleanRows = performance.now() - mark

        mark = performance.now()
        for (const row of staged) row.element.remove()
        const removeFromDom = performance.now() - mark

        mark = performance.now()
        void host.getBoundingClientRect().height
        const layoutAfterRemove = performance.now() - mark

        for (const row of staged) unmount(row.instance)
        return { cleanLayout, insert, layoutAfterInsert, measureCleanRows, removeFromDom, layoutAfterRemove, measured: heights.length }
    }

    await round(300)
    const collected: Array<Awaited<ReturnType<typeof round>>> = []
    for (let i = 0; i < rounds; i += 1) collected.push(await round(320 + 70 * i))
    const pick = (key: keyof (typeof collected)[0]) => stats(collected.map(entry => entry[key] as number))
    return {
        k,
        residentRows: document.querySelectorAll('[data-chat-row]').length,
        cleanLayout: pick('cleanLayout'),
        insert: pick('insert'),
        layoutAfterInsert: pick('layoutAfterInsert'),
        measureCleanRows: pick('measureCleanRows'),
        removeFromDom: pick('removeFromDom'),
        layoutAfterRemove: pick('layoutAfterRemove'),
    }
}

const probe = {
    parts,
    trackRow,
    marginalLayout,
    /**
     * The app's own `chat-row-measure` samples -- the forced layout
     * `updateChatBody` takes to size the spacers, measured by the shipped code
     * rather than by this page.
     */
    report: () => {
        const exported = runtimePerformanceReport.export()
        return { counts: exported.counts, rowMeasure: stats(exported.durations['chat-row-measure'] ?? []) }
    },
    resetReport: () => resetRuntimePerformanceReportForTesting(),
    heights: () => ({ rows: rowHeights().length, height: stats(rowHeights()), scrollHeight: scroller.scrollHeight }),
    run,
    scrollToMiddle: () => { scroller.scrollTop = Math.round(scroller.scrollHeight / 2) },
    mountedRows: () => document.querySelectorAll('[data-chat-row]').length,
    /**
     * The live array the component is rendering, so a driver can check that
     * each mounted row is showing the message it names -- and can edit, swipe
     * and delete messages the way the app does. A dynamic import cannot reach
     * it: Vite hands a fresh module instance to a late importer, and the store
     * in it is not the one this page mounted against.
     */
    messages: () => DBState.db.characters[0].chats[0].message as any[],
    ready: false,
}
;(window as any).__probe = probe

setTimeout(() => {
    probe.ready = true
    log(`mounted ${probe.mountedRows()} rows of ${MESSAGE_COUNT} messages (${MESSAGE_LENGTH} Hangul each), saver=${SAVER}`)
    log(`row height ${JSON.stringify(probe.heights())}`)
    log('ready')
}, 3_000)
