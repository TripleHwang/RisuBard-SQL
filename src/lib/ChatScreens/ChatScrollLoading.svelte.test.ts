import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { character } from 'src/ts/storage/database.svelte'

/**
 * The whole loop, end to end: a real `Chats.svelte` mounted over a chat that is
 * hydrated one reverse page at a time by the real SQL runtime, driven by the
 * real scroll loader.
 *
 * The pieces were each defensible on their own before this existed -- the
 * storage window paged, the DOM window was bounded, the loader was single
 * flight -- and the screen still could not walk back through a history, because
 * the only thing that called `loadOlderChatMessages` was a button that scrolled
 * out of reach. Nothing below asserts on source text.
 */

const activeStorage = vi.hoisted(() => ({ current: null as any }))

vi.mock('src/ts/storage/sql/sqlBootstrap', () => ({
    getActiveSqlStorage: () => activeStorage.current,
}))

const Chats = (await import('./Chats.svelte')).default
const { DBState, selectedCharID } = await import('src/ts/stores.svelte')
const { createOlderMessageLoader } = await import('src/ts/chatScrollPaging')
const { ensureChatMessageWindow, loadNewestChatMessages, loadOlderChatMessages } =
    await import('src/ts/storage/sql/sqlRuntimeHydration')
const { hasNewerSqlMessages, hasOlderSqlMessages } = await import('src/ts/storage/sql/sqlRuntimeWindow')
const { resetMountedMessageRegistryForTesting } = await import('src/ts/chatMountRegistry')
const { resetSqlPersistenceRuntimeForTesting } = await import('src/ts/storage/sql/sqlPersistenceRuntime')

const PAGE = 40
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
        RecordingIntersectionObserver.live = RecordingIntersectionObserver.live.filter(observer => observer !== this)
    }
    takeRecords(): IntersectionObserverEntry[] { return [] }
    reportVisible(selector: string) {
        const target = [...this.targets].find(candidate => candidate.matches(selector))
        if (!target) throw new Error(`no observed element matches ${selector}`)
        this.callback([{ target, isIntersecting: true } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
}

/**
 * The browser's animation frames, stood in for the same reason its
 * intersection reporting is.
 *
 * A sentinel report no longer moves the whole window in the turn that receives
 * it. The screen mounts what one frame can afford and asks for another until
 * the step is finished, which is what stopped a slide freezing the scroll for
 * ninety milliseconds. happy-dom has no frames, so a test that only reported
 * the sentinel would watch the window move by a single row and conclude it had
 * stopped -- and never reach the oldest resident message at all.
 */
class RecordingAnimationFrames {
    static pending = new Map<number, FrameRequestCallback>()
    static next = 1
    static request(callback: FrameRequestCallback): number {
        const handle = RecordingAnimationFrames.next
        RecordingAnimationFrames.next += 1
        RecordingAnimationFrames.pending.set(handle, callback)
        return handle
    }
    static cancel(handle: number) { RecordingAnimationFrames.pending.delete(handle) }
    static reset() { RecordingAnimationFrames.pending.clear() }
    /** Run frames, and everything they schedule, until nothing asks for another. */
    static drain(limit = 2_000) {
        for (let frame = 0; frame < limit; frame += 1) {
            const next = RecordingAnimationFrames.pending.entries().next()
            if (next.done) return frame
            const [handle, callback] = next.value
            RecordingAnimationFrames.pending.delete(handle)
            callback(0)
            flushSync()
        }
        throw new Error('the chat screen never stopped asking for animation frames')
    }
}

function buildHistory(count: number) {
    return Array.from({ length: count }, (_, position) => ({
        chatId: `m-${position}`,
        role: position % 2 === 0 ? 'user' : 'char',
        data: `message ${position}`,
    }))
}

/** The node backend's reverse-page contract, served from an in-memory history. */
function serveHistory(history: ReturnType<typeof buildHistory>) {
    const loadChatMessageReversePage = vi.fn(async (chatId: string, before: number | undefined, limit: number) => {
        const end = before === undefined ? history.length : before
        const start = Math.max(0, end - limit)
        const slice = history.slice(start, end)
        return {
            revision: 1,
            chatId,
            messages: slice.map((message) => ({ ...message })),
            positions: slice.map((_, index) => start + index),
            nextPosition: history.length,
            before: before ?? null,
            nextBefore: start > 0 ? start : null,
            total: history.length,
            hasMore: start > 0,
        }
    })
    activeStorage.current = {
        backendKind: 'server-sql',
        loadCharacterHydration: vi.fn(),
        loadChatMessageReversePage,
    }
    return loadChatMessageReversePage
}

let chatSequence = 0

function reactiveCharacter(): character {
    chatSequence += 1
    const state = $state({
        chaId: 'character-1',
        name: 'Tester',
        type: 'character',
        image: '',
        chatPage: 0,
        chats: [{
            id: `chat-${chatSequence}`,
            name: 'chat',
            note: '',
            localLore: [],
            message: [] as any[],
            _placeholder: true,
            messagesLoaded: false,
        }],
        alternateGreetings: [],
        firstMessage: 'hi',
        emotionImages: [],
        customscript: [],
        globalLore: [],
    })
    return state as unknown as character
}

let mounted: Record<string, any> | null = null
let host: HTMLDivElement | null = null

/** The screen as the app wires it: component, loader, and the link between them. */
async function openChat(historyLength: number) {
    const history = buildHistory(historyLength)
    const backend = serveHistory(history)
    const currentCharacter = reactiveCharacter()
    DBState.db.characters = [currentCharacter as any]
    selectedCharID.set(0)
    await ensureChatMessageWindow(currentCharacter, 0, PAGE)
    const chat = currentCharacter.chats[0]

    const errors: unknown[] = []
    const loadingStates: boolean[] = []
    const loader = createOlderMessageLoader({
        hasOlder: () => hasOlderSqlMessages(currentCharacter.chats[currentCharacter.chatPage]),
        load: () => loadOlderChatMessages(currentCharacter, currentCharacter.chatPage, PAGE),
        onLoadingChange: (loading) => loadingStates.push(loading),
        onError: (error) => errors.push(error),
    })

    let lastRequest: Promise<unknown> = Promise.resolve()
    // Every outcome the loader handed back, so a burst can be checked against
    // the loader's own coalescing. Counting backend calls alone does not do it:
    // `loadOlderChatMessages` keeps its own per-chat in-flight map, so the
    // backend stays at one call even with the loader's gate taken out.
    const outcomes: Promise<string>[] = []
    const scroller = document.createElement('div')
    host = document.createElement('div')
    host.appendChild(scroller)
    document.body.appendChild(host)
    mounted = mount(Chats, {
        target: scroller,
        props: {
            messages: chat.message,
            currentCharacter,
            onReroll: () => {},
            unReroll: () => {},
            currentUsername: 'user',
            userIcon: '',
            onReachOldestMounted: () => {
                const request = loader.request()
                outcomes.push(request)
                lastRequest = request
            },
        },
    }) as Record<string, any>
    flushSync()

    const observer = () => {
        const live = RecordingIntersectionObserver.live.at(-1)
        if (!live) throw new Error('the chat screen is not observing its scroll ends')
        return live
    }

    return {
        backend,
        chat,
        currentCharacter,
        errors,
        loader,
        loadingStates,
        history,
        scroller,
        settledOutcomes: () => Promise.all(outcomes),
        mountedIds: () => Array.from(scroller.querySelectorAll('[data-chat-row]'))
            .map(element => element.getAttribute('data-chat-row')!),
        /** One scroll gesture reaching the older end, settled. */
        scrollOlder: async () => {
            observer().reportVisible(OLDER_SENTINEL)
            flushSync()
            // The step the report started runs across frames now, so the window
            // has not reached the oldest resident row -- and storage has not
            // been asked for the page after it -- until these have run.
            RecordingAnimationFrames.drain()
            await lastRequest
            flushSync()
            RecordingAnimationFrames.drain()
        },
        /** A flick: several intersection reports before the page comes back. */
        flickOlder: async (times: number) => {
            for (let attempt = 0; attempt < times; attempt += 1) {
                observer().reportVisible(OLDER_SENTINEL)
                flushSync()
                RecordingAnimationFrames.drain()
            }
            flushSync()
            await lastRequest
            flushSync()
            RecordingAnimationFrames.drain()
        },
    }
}

beforeEach(() => {
    RecordingIntersectionObserver.live = []
    vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
    RecordingAnimationFrames.reset()
    vi.stubGlobal('requestAnimationFrame', RecordingAnimationFrames.request)
    vi.stubGlobal('cancelAnimationFrame', RecordingAnimationFrames.cancel)
    activeStorage.current = null
    resetMountedMessageRegistryForTesting()
})

afterEach(() => {
    if (mounted) unmount(mounted)
    mounted = null
    host?.remove()
    host = null
    RecordingAnimationFrames.reset()
    vi.unstubAllGlobals()
    resetMountedMessageRegistryForTesting()
    resetSqlPersistenceRuntimeForTesting()
})

describe('scrolling back through a history that is not all resident', () => {
    it('loads an older page when the scroll reaches the oldest resident message', async () => {
        const screen = await openChat(1_000)
        expect(screen.chat.message).toHaveLength(PAGE)
        expect(screen.backend).toHaveBeenCalledTimes(1)

        // The newest 40 all fit inside the DOM window, so the very first report
        // of the older end is already the start of what is resident.
        await screen.scrollOlder()

        expect(screen.backend).toHaveBeenCalledTimes(2)
        expect(screen.chat.message).toHaveLength(2 * PAGE)
        expect(screen.chat.message[0].chatId).toBe(`m-${1_000 - 2 * PAGE}`)
        expect(screen.errors).toEqual([])
    })

    it('does not fire several loads for one fast scroll', async () => {
        const screen = await openChat(1_000)

        await screen.flickOlder(6)

        // Six reports, one page. Two in flight together could interleave their
        // splices into the same array.
        expect(screen.backend).toHaveBeenCalledTimes(2)
        expect(screen.chat.message).toHaveLength(2 * PAGE)
        // And one page because *this screen's* loader held the burst, not
        // because storage happened to deduplicate underneath it. Without this
        // the assertion above still passes with the loader's gate removed:
        // `loadOlderChatMessages` has a per-chat in-flight map of its own, so
        // the backend call count cannot distinguish the two.
        const outcomes = await screen.settledOutcomes()
        expect(outcomes.filter(outcome => outcome === 'loaded')).toHaveLength(1)
        expect(outcomes.filter(outcome => outcome === 'coalesced')).toHaveLength(outcomes.length - 1)
        expect(outcomes.length).toBeGreaterThan(1)
    })

    it('keeps the array spliced, so the mounted conversation survives a load', async () => {
        const screen = await openChat(1_000)
        const array = screen.chat.message
        const stillMounted = screen.mountedIds().at(-1)!

        await screen.scrollOlder()

        expect(screen.chat.message).toBe(array)
        expect(screen.mountedIds()).toContain(stillMounted)
    })

    it('stops cleanly at the start of the persisted history', async () => {
        const screen = await openChat(120)

        for (let guard = 0; guard < 20 && hasOlderSqlMessages(screen.chat); guard += 1) {
            await screen.scrollOlder()
        }

        expect(hasOlderSqlMessages(screen.chat)).toBe(false)
        expect(screen.chat.message).toHaveLength(120)
        const callsAtStart = screen.backend.mock.calls.length

        // Keep scrolling into the top of the conversation. The end of history
        // is a normal stop: nothing is fetched, nothing fails, and nothing is
        // left showing as loading.
        await screen.scrollOlder()
        await screen.scrollOlder()

        expect(screen.backend).toHaveBeenCalledTimes(callsAtStart)
        expect(screen.errors).toEqual([])
        expect(screen.loader.loading).toBe(false)
        expect(screen.loadingStates.at(-1)).toBe(false)
    })

    it('gets back to the newest messages after residency trimming released them', async () => {
        const screen = await openChat(1_000)

        for (let guard = 0; guard < 40 && !hasNewerSqlMessages(screen.chat); guard += 1) {
            await screen.scrollOlder()
        }
        // The newest end really is gone from memory, which is what makes this
        // more than a scroll: there is nothing left on screen to scroll to.
        expect(hasNewerSqlMessages(screen.chat)).toBe(true)
        expect(screen.chat.message.some((message) => message.chatId === 'm-999')).toBe(false)

        await loadNewestChatMessages(screen.currentCharacter, 0, PAGE)
        flushSync()
        mounted!.scrollToLatestMessage()
        flushSync()

        expect(hasNewerSqlMessages(screen.chat)).toBe(false)
        expect(screen.chat.message.at(-1)!.chatId).toBe('m-999')
        expect(screen.mountedIds()).toContain('m-999')
    // Walking a thousand messages back mounts and unmounts real chat rows by
    // the hundred; the default 5 s budget is about the renderer, not the logic.
    }, 60_000)
})
