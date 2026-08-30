import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Chats from './Chats.svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'

/**
 * What replaced the previous/next page buttons.
 *
 * This file used to be `ChatPaginationConnections.test.ts`, which read
 * `Chats.svelte` and `DefaultChatScreen.svelte` as text and asserted that
 * `data-chat-page-previous` and friends appeared in them. That proved the
 * markup existed; it could not notice that the nav lived *inside* the
 * `flex-col-reverse` scroll container and scrolled out of reach the first time
 * it was used. So everything below drives the real component: a real mount, a
 * real DOM, and the browser's intersection reporting stood in for -- because
 * happy-dom's IntersectionObserver never fires -- so the window is moved by
 * exactly the signal that moves it in a browser.
 */

const OLDER_SENTINEL = '[data-chat-sentinel="older"]'
const NEWER_SENTINEL = '[data-chat-sentinel="newer"]'

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

    /** Report the sentinel matching `selector` as having scrolled into view. */
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

/**
 * The app hands this component `chat.message`, which is a `$state` proxy that
 * storage splices older pages into. A plain array would let the window tests
 * pass while the prepend case -- the one the whole feature exists for -- was
 * never actually observed.
 */
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
/**
 * The object the component actually reads. `DBState.db.characters[0]` is a
 * separate `$state` proxy, and the component holds the prop, so a test that
 * wants to change what the component sees has to change this.
 */
let renderedCharacter: any = null

function render(messages: any[], extra: Record<string, unknown> = {}) {
    const currentCharacter = buildCharacter(messages)
    renderedCharacter = currentCharacter
    DBState.db.characters = [currentCharacter]
    selectedCharID.set(0)
    // The component observes `chatBody.parentElement` as the scroll root, which
    // is the `flex flex-col-reverse overflow-y-auto` element in the real screen.
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

function mountedIndices(container: HTMLElement): number[] {
    return Array.from(container.querySelectorAll('[data-chat-row]'))
        .map(element => Number(element.getAttribute('data-chat-row')!.slice(2)))
        .sort((left, right) => left - right)
}

beforeEach(() => {
    RecordingIntersectionObserver.live = []
    vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
})

afterEach(() => {
    if (mounted) unmount(mounted)
    mounted = null
    host?.remove()
    host = null
    vi.unstubAllGlobals()
})

describe('the chat screen follows the scroll instead of a page number', () => {
    it('opens on the newest messages', () => {
        const container = render(reactiveMessages(400))
        const indices = mountedIndices(container)

        expect(indices.at(-1)).toBe(399)
        expect(indices.at(0)).toBeGreaterThan(0)
        // Bounded, and bounded around the newest end rather than around a page.
        expect(indices.length).toBeLessThanOrEqual(60)
    })

    it('watches both ends of the scroll rather than a control in the scrolled content', () => {
        const container = render(reactiveMessages(400))

        expect(container.querySelector(OLDER_SENTINEL)).not.toBeNull()
        expect(container.querySelector(NEWER_SENTINEL)).not.toBeNull()
        // The controls this replaced could be scrolled past and never reached again.
        expect(container.querySelector('[data-chat-page-previous]')).toBeNull()
        expect(container.querySelector('[data-chat-page-next]')).toBeNull()
        expect(RecordingIntersectionObserver.live.at(-1)!.targets.size).toBe(2)
    })

    it('mounts older messages as the oldest mounted row comes into view', () => {
        const container = render(reactiveMessages(400))
        const before = mountedIndices(container)

        scrollTo(OLDER_SENTINEL)
        const after = mountedIndices(container)

        expect(after.at(0)!).toBeLessThan(before.at(0)!)
        // Still bounded: the window slid, it did not grow.
        expect(after.length).toBeLessThanOrEqual(60)
    })

    it('slides back towards the newest messages when the newer end comes into view', () => {
        const container = render(reactiveMessages(400))
        scrollTo(OLDER_SENTINEL)
        scrollTo(OLDER_SENTINEL)
        const scrolledBack = mountedIndices(container)
        expect(scrolledBack.at(-1)).toBeLessThan(399)

        scrollTo(NEWER_SENTINEL)
        expect(mountedIndices(container).at(-1)!).toBeGreaterThan(scrolledBack.at(-1)!)
    })

    it('asks for an older page only once the oldest resident message is mounted', () => {
        const onReachOldestMounted = vi.fn()
        const container = render(reactiveMessages(400), { onReachOldestMounted })

        scrollTo(OLDER_SENTINEL)
        // There are still resident messages left to mount, so nothing needs
        // fetching yet: a request here would page storage for history the
        // screen is already holding.
        expect(onReachOldestMounted).not.toHaveBeenCalled()

        for (let guard = 0; guard < 100 && !mountedIndices(container).includes(0); guard += 1) {
            scrollTo(OLDER_SENTINEL)
        }
        expect(mountedIndices(container)).toContain(0)
        expect(onReachOldestMounted).toHaveBeenCalled()
    })

    it('asks storage on the slide that reaches the oldest resident message, not on a later report', () => {
        const onReachOldestMounted = vi.fn()
        // 400 messages, a 60-row window sliding by 31: the slide that finally
        // reaches index 0 mounts only the remainder. In a browser that handful
        // of rows may not be tall enough to push the older sentinel back out of
        // the 600px root margin, and IntersectionObserver does not re-notify a
        // target that stays intersecting -- so a request deferred to "the next
        // report" is a request that never happens, and the rest of the history
        // stays on disk with no spinner, no error and no control.
        const container = render(reactiveMessages(400), { onReachOldestMounted })

        let reports = 0
        while (!mountedIndices(container).includes(0) && reports < 100) {
            scrollTo(OLDER_SENTINEL)
            reports += 1
        }
        expect(mountedIndices(container)).toContain(0)
        // Called by the slide itself, with no further scroll signal needed.
        expect(onReachOldestMounted).toHaveBeenCalledTimes(1)
    })

    it('reports which end of the history is on screen', () => {
        const onWindowChange = vi.fn()
        const container = render(reactiveMessages(400), { onWindowChange })

        expect(onWindowChange).toHaveBeenLastCalledWith({ atOldestEnd: false, atNewestEnd: true })

        for (let guard = 0; guard < 100 && !mountedIndices(container).includes(0); guard += 1) {
            scrollTo(OLDER_SENTINEL)
        }
        // This is what tells the screen to draw the greeting, and to offer the
        // way back to the latest messages.
        expect(onWindowChange).toHaveBeenLastCalledWith({ atOldestEnd: true, atNewestEnd: false })
    })

    it('keeps the way back to the latest messages while a reply streams', () => {
        const onWindowChange = vi.fn()
        const container = render(reactiveMessages(400), { onWindowChange })
        renderedCharacter.chats[0].isStreaming = true
        renderedCharacter.chats[0].activeStreamingDisplayOptimizationMode = 'balanced'

        for (let guard = 0; guard < 4; guard += 1) scrollTo(OLDER_SENTINEL)

        // The streaming override force-mounts the tail so the live reply keeps
        // updating, which means the mounted window says "newest end" while the
        // reader is scrolled hundreds of messages away from it, looking at the
        // spacer that override left behind. Reporting the mounted window here
        // would delete the one control that gets them back.
        expect(mountedIndices(container)).toContain(399)
        expect(onWindowChange).toHaveBeenLastCalledWith({ atOldestEnd: false, atNewestEnd: false })
    })

    it('returns to the newest messages from anywhere in the scroll', () => {
        const container = render(reactiveMessages(400))
        for (let guard = 0; guard < 100 && !mountedIndices(container).includes(0); guard += 1) {
            scrollTo(OLDER_SENTINEL)
        }
        expect(mountedIndices(container)).not.toContain(399)

        mounted!.scrollToLatestMessage()
        flushSync()

        expect(mountedIndices(container).at(-1)).toBe(399)
        // Up to a hundred sentinel reports, each a synchronous re-render of a
        // 400-message reactive array. Fast alone, past the default 5s when the
        // whole suite is competing for the machine.
    }, 30_000)

    it('keeps the anchored message on screen when older history is prepended', () => {
        const messages = reactiveMessages(400)
        const container = render(messages)
        scrollTo(OLDER_SENTINEL)
        scrollTo(OLDER_SENTINEL)
        const anchored = mounted!.getAnchorId()
        expect(anchored).not.toBeNull()

        // A page of older history arrives; every index shifts by 40. An
        // index-based anchor would drag the view 40 messages further back.
        // Spliced, never replaced -- replacing the array unmounts every row.
        messages.splice(0, 0, ...Array.from({ length: 40 }, (_, index) => ({
            chatId: `older-${index}`,
            role: 'char',
            data: `older ${index}`,
        })) as any[])
        flushSync()

        const rows = Array.from(container.querySelectorAll('[data-chat-row]'))
            .map(element => element.getAttribute('data-chat-row'))
        expect(rows).toContain(anchored)
        expect(mounted!.getAnchorId()).toBe(anchored)
    })

    it('mounts around a message the screen was asked to reveal', () => {
        const container = render(reactiveMessages(400))

        mounted!.revealMessage(12)
        flushSync()

        const indices = mountedIndices(container)
        expect(indices).toContain(12)
        expect(indices.length).toBeLessThanOrEqual(60)
    })
})
