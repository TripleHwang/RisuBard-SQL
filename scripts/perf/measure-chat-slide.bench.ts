// @vitest-environment happy-dom
/**
 * What one DOM-window slide costs.
 *
 * `Chats.svelte` keeps `domLimit()` rows mounted (60, or 40 in saver mode) and
 * moves that window by `Math.floor(limit / 2)` -- 30 rows -- whenever a sentinel
 * reports. Moving it unmounts every row that left and mounts every row that
 * entered, synchronously, inside one effect. This file measures that burst and
 * splits it into its parts, so that the fix is aimed at whatever actually
 * dominates rather than at the part that looks expensive.
 *
 * Everything here is measurement. No assertions, no budgets.
 *
 * Read the numbers with two caveats:
 *   - happy-dom's DOM is JavaScript, so node creation and `innerHTML` parsing
 *     are slower here than in Chromium, while there is no layout or paint at
 *     all. Ratios between the parts are the trustworthy output; absolute
 *     milliseconds are an upper bound on the JS half and say nothing about
 *     layout.
 *   - the fixture is Korean, because an English one has misled this project
 *     twice: V8 stores any string with a non-Latin1 character two bytes per
 *     code unit and takes `JSON.stringify` off its one-byte fast path.
 *
 * Run with:
 *   npx vitest run --config vitest.config.perf.ts scripts/perf/measure-chat-slide.bench.ts
 */
import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, it, vi } from 'vitest'

import Chat from '../../src/lib/ChatScreens/Chat.svelte'
import Chats from '../../src/lib/ChatScreens/Chats.svelte'
import { bumpReloadChatPointer, createSimpleCharacter, DBState, selectedCharID, ReloadChatPointer } from '../../src/ts/stores.svelte'
import { get } from 'svelte/store'
import { resetRuntimePerformanceReportForTesting } from '../../src/ts/performance/performanceReport'
import { koreanText } from './koreanFixture'
import { reactiveKoreanMessages } from './chatRenderProbe.svelte'

const OLDER_SENTINEL = '[data-chat-sentinel="older"]'
const NEWER_SENTINEL = '[data-chat-sentinel="newer"]'

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

const now = () => performance.now()

function stats(samples: number[]) {
    const sorted = [...samples].sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
    return {
        n: sorted.length,
        min: sorted[0] ?? 0,
        median: at(0.5),
        p90: at(0.9),
        max: sorted[sorted.length - 1] ?? 0,
        mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
    }
}

const pending: string[] = []
function head(text: string): void { pending.push(`\n  ${text}`) }
function row(label: string, value: string): void { pending.push(`    ${label.padEnd(44)} ${value}`) }
function ms(value: number): string { return `${value.toFixed(3)} ms` }
function summary(label: string, samples: number[]): void {
    const s = stats(samples)
    row(label, `n=${s.n}  median ${ms(s.median)}  mean ${ms(s.mean)}  p90 ${ms(s.p90)}  max ${ms(s.max)}`)
}
function flushReport(): void {
    if (pending.length) process.stdout.write(`${pending.join('\n')}\n`)
    pending.length = 0
}

let mounted: Record<string, any> | null = null
let host: HTMLDivElement | null = null
const strays: Array<Record<string, any>> = []

function buildCharacter(messages: any[]) {
    return {
        chaId: 'character-1', name: '캐릭터', type: 'character', image: '',
        chatPage: 0,
        chats: [{ id: 'chat-1', name: '대화', note: '', localLore: [], message: messages }],
        alternateGreetings: [], firstMessage: '안녕', emotionImages: [],
        customscript: [], globalLore: [],
    } as any
}

function renderChats(messages: any[], saverMode = false) {
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
            messages, currentCharacter, saverMode,
            onReroll: () => {}, unReroll: () => {},
            currentUsername: '사용자', userIcon: '',
        },
    }) as Record<string, any>
    flushSync()
    return { scroller, currentCharacter }
}

/** Exactly the props `updateChatBody` hands each row, for standalone timing. */
function chatProps(messages: any[], index: number, currentCharacter: any) {
    const message = messages[index]
    return {
        message: message.data,
        isLastMemory: false,
        idx: index,
        messageId: message.chatId,
        totalLength: messages.length,
        img: '',
        onReroll: () => {}, onNextSwipe: () => {}, unReroll: () => {}, onDeleteSwipe: () => {},
        onConfirmMemory: async () => false,
        memoryConfirmed: false,
        canonicalReceipt: undefined,
        rerollIcon: false as const,
        character: createSimpleCharacter(currentCharacter),
        largePortrait: false,
        messageGenerationInfo: message.generationInfo,
        role: message.role,
        name: message.role === 'user' ? '사용자' : '캐릭터',
        isComment: false,
        disabled: false,
        isOptimizedStreamingMessage: false,
        streamingOptimizationMode: 'off' as const,
        rawStreamingText: message.data,
    }
}

/** The container `updateChatBody` builds around every row. */
function makeContainer(messageId: string): HTMLDivElement {
    const b = document.createElement('div')
    b.setAttribute('data-chat-row', messageId)
    b.setAttribute('data-chat-id', messageId)
    b.classList.add('chat-message-container')
    return b
}

beforeEach(() => {
    RecordingIntersectionObserver.live = []
    vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
    resetRuntimePerformanceReportForTesting()
    DBState.db.streamingDisplayOptimizationMode = 'off'
    DBState.db.autoScrollToNewMessage = true
    DBState.db.alwaysScrollToNewMessage = false
})

afterEach(() => {
    if (mounted) unmount(mounted)
    mounted = null
    while (strays.length) { try { unmount(strays.pop()!) } catch { /* ignore */ } }
    host?.remove()
    host = null
    vi.unstubAllGlobals()
    resetRuntimePerformanceReportForTesting()
    flushReport()
})

describe('the cost of one DOM-window slide', () => {
    it('A. a real slide, up and down, timed end to end', () => {
        const messages = reactiveKoreanMessages(1_200, 400)
        renderChats(messages)
        const observer = () => RecordingIntersectionObserver.live.at(-1)!

        // Warm: the first slide pays JIT and lazy module init for the whole
        // component graph and is not what a scrolling reader sees.
        const warm: number[] = []
        for (let i = 0; i < 3; i += 1) {
            const started = now()
            observer().reportVisible(OLDER_SENTINEL)
            flushSync()
            warm.push(now() - started)
        }

        const up: number[] = []
        for (let i = 0; i < 12; i += 1) {
            const started = now()
            observer().reportVisible(OLDER_SENTINEL)
            flushSync()
            up.push(now() - started)
        }
        const down: number[] = []
        for (let i = 0; i < 12; i += 1) {
            const started = now()
            observer().reportVisible(NEWER_SENTINEL)
            flushSync()
            down.push(now() - started)
        }
        // Back up again, to check the direction difference is not just order.
        const upAgain: number[] = []
        for (let i = 0; i < 12; i += 1) {
            const started = now()
            observer().reportVisible(OLDER_SENTINEL)
            flushSync()
            upAgain.push(now() - started)
        }

        head('[A] real Chats, 1,200 messages of 400 Hangul, 60-row window, step 30')
        row('first slide (cold)', ms(warm[0]))
        summary('slide up   (older)', up)
        summary('slide down (newer)', down)
        summary('slide up   again', upAgain)
    })

    it('B. the same slide with nothing to do (a no-op pass)', () => {
        const messages = reactiveKoreanMessages(1_200, 400)
        renderChats(messages)
        const observer = () => RecordingIntersectionObserver.live.at(-1)!
        for (let i = 0; i < 4; i += 1) { observer().reportVisible(OLDER_SENTINEL); flushSync() }

        // A pass that re-runs the effect without moving the window and without
        // changing a single row. The render effect tracks `ReloadChatPointer`
        // explicitly, so bumping it for a message that is NOT in the window
        // re-runs the whole 60-row loop and leaves every signature and every
        // streaming prop exactly as it was: the pure overhead of a pass.
        const idle: number[] = []
        for (let i = 0; i < 60; i += 1) {
            const started = now()
            bumpReloadChatPointer(`not-mounted-${i}`)
            flushSync()
            idle.push(now() - started)
        }

        head('[B] effect pass with no window movement (60-row signature loop only)')
        summary('idle pass', idle)
    })

    it('C. the parts: unmount, container, mount(Chat)', () => {
        const messages = reactiveKoreanMessages(400, 400)
        const currentCharacter = buildCharacter(messages)
        DBState.db.characters = [currentCharacter]
        selectedCharID.set(0)
        const target = document.createElement('div')
        document.body.appendChild(target)

        const mountBatch = (count: number, offset: number) => {
            const made: Array<{ inst: any, el: HTMLDivElement }> = []
            for (let i = 0; i < count; i += 1) {
                const index = offset + i
                const el = makeContainer(messages[index].chatId)
                target.appendChild(el)
                made.push({ inst: mount(Chat, { target: el, props: chatProps(messages, index, currentCharacter) }), el })
            }
            return made
        }

        // Warm up the component graph.
        for (const m of mountBatch(5, 0)) { unmount(m.inst); m.el.remove() }
        flushSync()

        const containerSamples: number[] = []
        const mountSamples: number[] = []
        const unmountSamples: number[] = []
        const nodeCounts: number[] = []

        for (let round = 0; round < 8; round += 1) {
            const offset = 20 + round * 30
            // container creation alone
            const containers: HTMLDivElement[] = []
            let started = now()
            for (let i = 0; i < 30; i += 1) containers.push(makeContainer(messages[offset + i].chatId))
            containerSamples.push(now() - started)
            for (const c of containers) target.appendChild(c)

            // mount(Chat) alone
            const insts: any[] = []
            started = now()
            for (let i = 0; i < 30; i += 1) {
                insts.push(mount(Chat, { target: containers[i], props: chatProps(messages, offset + i, currentCharacter) }))
            }
            mountSamples.push(now() - started)
            nodeCounts.push(containers[0].querySelectorAll('*').length)

            // unmount + element.remove(), which is what a slide does to the rows
            // that left the window
            started = now()
            for (let i = 0; i < 30; i += 1) { unmount(insts[i]); containers[i].remove() }
            unmountSamples.push(now() - started)
        }

        head('[C] 30 rows at a time, real Chat component, 400-Hangul bodies')
        summary('create 30 containers', containerSamples)
        summary('mount(Chat) x30', mountSamples)
        summary('unmount + remove x30', unmountSamples)
        row('DOM nodes inside one mounted row', String(nodeCounts.at(-1) ?? 0))
        row('per row: mount', ms(stats(mountSamples).median / 30))
        row('per row: unmount', ms(stats(unmountSamples).median / 30))
        row('per row: container', ms(stats(containerSamples).median / 30))
        target.remove()
    })

    it('D. how mount cost scales with the number of rows', () => {
        const messages = reactiveKoreanMessages(400, 400)
        const currentCharacter = buildCharacter(messages)
        DBState.db.characters = [currentCharacter]
        selectedCharID.set(0)
        const target = document.createElement('div')
        document.body.appendChild(target)

        const measure = (count: number) => {
            const samples: number[] = []
            for (let round = 0; round < 5; round += 1) {
                const containers: HTMLDivElement[] = []
                for (let i = 0; i < count; i += 1) {
                    const el = makeContainer(`${messages[i].chatId}-r${round}`)
                    target.appendChild(el)
                    containers.push(el)
                }
                const insts: any[] = []
                const started = now()
                for (let i = 0; i < count; i += 1) {
                    insts.push(mount(Chat, { target: containers[i], props: chatProps(messages, i, currentCharacter) }))
                }
                samples.push(now() - started)
                for (let i = 0; i < count; i += 1) { unmount(insts[i]); containers[i].remove() }
            }
            return samples
        }

        measure(5) // warm
        head('[D] mount(Chat) x N -- is the slide cost linear in the step?')
        for (const count of [1, 5, 10, 20, 30, 40, 60]) {
            const s = stats(measure(count))
            row(`mount x${String(count).padStart(2, ' ')}`, `median ${ms(s.median)}   per row ${ms(s.median / count)}`)
        }
        target.remove()
    })

    it('E. how mount cost scales with message length', () => {
        head('[E] mount(Chat) x30 against Hangul body length')
        for (const length of [40, 100, 400, 1_200, 3_000]) {
            const messages = reactiveKoreanMessages(120, length)
            const currentCharacter = buildCharacter(messages)
            DBState.db.characters = [currentCharacter]
            selectedCharID.set(0)
            const target = document.createElement('div')
            document.body.appendChild(target)
            const samples: number[] = []
            for (let round = 0; round < 5; round += 1) {
                const containers: HTMLDivElement[] = []
                for (let i = 0; i < 30; i += 1) {
                    const el = makeContainer(`${messages[i].chatId}-r${round}`)
                    target.appendChild(el)
                    containers.push(el)
                }
                const insts: any[] = []
                const started = now()
                for (let i = 0; i < 30; i += 1) insts.push(mount(Chat, { target: containers[i], props: chatProps(messages, i, currentCharacter) }))
                samples.push(now() - started)
                for (let i = 0; i < 30; i += 1) { unmount(insts[i]); containers[i].remove() }
            }
            const s = stats(samples)
            row(`${String(length).padStart(4, ' ')} Hangul per message`, `median ${ms(s.median)}   per row ${ms(s.median / 30)}`)
            target.remove()
        }
    })

    it('F. how the whole slide scales with the resident message count', () => {
        head('[F] one slide, step 30, against messages.length (Chat.idx is a findIndex per row)')
        for (const total of [400, 800]) {
            const messages = reactiveKoreanMessages(total, 400)
            renderChats(messages)
            const observer = () => RecordingIntersectionObserver.live.at(-1)!
            for (let i = 0; i < 2; i += 1) { observer().reportVisible(OLDER_SENTINEL); flushSync() }
            const samples: number[] = []
            for (let i = 0; i < 8; i += 1) {
                const started = now()
                observer().reportVisible(OLDER_SENTINEL)
                flushSync()
                samples.push(now() - started)
            }
            const s = stats(samples)
            row(`${String(total).padStart(4, ' ')} resident messages`, `median ${ms(s.median)}  p90 ${ms(s.p90)}`)
            if (mounted) { unmount(mounted); mounted = null }
            host?.remove(); host = null
        }
    })

    it('G. the per-row signature string, built for all 60 rows on every pass', () => {
        const messages = reactiveKoreanMessages(60, 400)
        const withReceipt = reactiveKoreanMessages(60, 400)
        for (const message of withReceipt) {
            message.risubardCanonicalReceipt = {
                turnId: `turn-${message.chatId}`,
                wikiVersion: 12,
                facts: Array.from({ length: 6 }, (_, i) => ({ id: `f-${i}`, text: koreanText(40, Math.random) })),
                createdAt: 1_700_000_000_000,
            }
        }
        const reloadPointerMap = get(ReloadChatPointer)

        const buildAll = (source: any[]) => {
            let sink = ''
            for (let i = source.length - 1; i >= 0; i -= 1) {
                const message = source[i]
                const messageLargePortrait = false
                const reloadPointer = reloadPointerMap[message.chatId] ?? 0
                const isRerollTarget = i === source.length - 1
                const hashMessageData = message.data
                sink = `${hashMessageData}|${messageLargePortrait}|${message.disabled}|${reloadPointer}|${message.swipeId ?? 0}|${message.swipes?.length ?? 0}|${isRerollTarget}|${message.risubardMemoryConfirmed ?? false}|${JSON.stringify(message.risubardCanonicalReceipt ?? null)}`
            }
            return sink
        }

        for (let i = 0; i < 50; i += 1) { buildAll(messages); buildAll(withReceipt) }

        const plain: number[] = []
        for (let i = 0; i < 300; i += 1) { const s = now(); buildAll(messages); plain.push(now() - s) }
        const receipts: number[] = []
        for (let i = 0; i < 300; i += 1) { const s = now(); buildAll(withReceipt); receipts.push(now() - s) }

        head('[G] 60 signatures, each concatenating the full 400-Hangul body')
        summary('receipt null (JSON.stringify(null))', plain)
        summary('receipt present (6 Korean facts)', receipts)
        row('per row, receipt null', ms(stats(plain).median / 60))
        row('per row, receipt present', ms(stats(receipts).median / 60))
    })

    it('H. saver mode: a 40-row window with a step of 20', () => {
        const messages = reactiveKoreanMessages(1_200, 400)
        renderChats(messages, true)
        const observer = () => RecordingIntersectionObserver.live.at(-1)!
        for (let i = 0; i < 3; i += 1) { observer().reportVisible(OLDER_SENTINEL); flushSync() }
        const samples: number[] = []
        for (let i = 0; i < 12; i += 1) {
            const started = now()
            observer().reportVisible(OLDER_SENTINEL)
            flushSync()
            samples.push(now() - started)
        }
        head('[H] saverMode -- 40-row window, step 20')
        summary('slide up (older)', samples)
        row('per row moved', ms(stats(samples).median / 20))
    })
})
