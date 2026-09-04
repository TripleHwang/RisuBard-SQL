import { request as httpRequest } from 'node:http'

import { flushSync, mount, unmount } from 'svelte'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Database, character } from 'src/ts/storage/database.svelte'

/**
 * The scroll-back loop and the greeting gate, driven against a REAL server.
 *
 * `ChatScrollLoading.svelte.test.ts` already mounts the real `Chats.svelte`
 * over the real SQL runtime, but the pages it walks come from a hand-written
 * backend, and that backend answered the terminal page with `nextBefore: null`.
 * The real server answered with the minimum position of its own rows instead,
 * which the client rejects -- so the last page of every chat longer than one
 * page failed in front of the user ("이전 메시지를 불러오지 못했습니다"), the
 * window's `hasOlder` never went false, and `DefaultChatScreen`'s greeting gate
 * (`atOldestEnd && !hasOlderSqlMessages(...)`) could never open. Five defects in
 * this project have now been found this way and none of them by a fixture, so
 * the pages here come from `server.cjs` running in its own process.
 *
 * happy-dom's `fetch` refuses cross-origin requests, which is every request to a
 * spawned server, so the transport below is a small `node:http` shim. It is the
 * only thing standing in for a browser; everything from `NodeSqliteStorage`
 * inwards, and everything from `Chats.svelte` outwards, is the real code.
 */

const activeStorage = vi.hoisted(() => ({ current: null as any }))

vi.mock('src/ts/storage/sql/sqlBootstrap', () => ({
    getActiveSqlStorage: () => activeStorage.current,
}))

const Chats = (await import('./Chats.svelte')).default
const { DBState, selectedCharID } = await import('src/ts/stores.svelte')
const { createOlderMessageLoader } = await import('src/ts/chatScrollPaging')
const { NodeSqliteStorage } = await import('src/ts/storage/sql/nodeSqliteStorage')
const { ensureChatMessageWindow, loadOlderChatMessages } =
    await import('src/ts/storage/sql/sqlRuntimeHydration')
const { hasOlderSqlMessages } = await import('src/ts/storage/sql/sqlRuntimeWindow')
const { resetMountedMessageRegistryForTesting } = await import('src/ts/chatMountRegistry')
const { resetSqlPersistenceRuntimeForTesting } = await import('src/ts/storage/sql/sqlPersistenceRuntime')
const { spawnServer } = await import('../../../test/compat/helpers/spawnServer')

type ServerHandle = Awaited<ReturnType<typeof spawnServer>>

/** Longer than one page, and not a multiple of it, so the last page is short. */
const HISTORY = 95
const PAGE = 40
const CHAT_ID = 'chat-greeting-live'
const CHARACTER_ID = 'character-greeting-live'
const OLDER_SENTINEL = '[data-chat-sentinel="older"]'

/**
 * `fetch` over `node:http`, because happy-dom's blocks every origin but the
 * document's. Only the parts `NodeSqliteStorage` uses are provided.
 */
function nodeFetch(port: number, token: string | null) {
    return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input), `http://127.0.0.1:${port}`)
        const headers: Record<string, string> = {}
        if (token) headers['risu-auth'] = token
        for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
            headers[key] = String(value)
        }
        const body = init?.body === undefined || init?.body === null
            ? null
            : Buffer.from(String(init.body), 'utf-8')
        if (body) headers['content-length'] = String(body.byteLength)
        return new Promise<Response>((resolve, reject) => {
            const req = httpRequest({
                hostname: '127.0.0.1',
                port,
                path: url.pathname + url.search,
                method: init?.method ?? 'GET',
                headers,
            }, (res) => {
                const chunks: Buffer[] = []
                res.on('data', (chunk: Buffer) => chunks.push(chunk))
                res.on('end', () => resolve(new Response(
                    Buffer.concat(chunks).toString('utf-8'),
                    { status: res.statusCode ?? 500 },
                )))
                res.on('error', reject)
            })
            req.on('error', reject)
            req.end(body ?? undefined)
        })
    }
}

function legacyDatabase(): Database {
    return {
        apiType: 'openai',
        username: 'reporter',
        maxContext: 4000,
        personas: [{ name: 'Default', icon: '', personaPrompt: '' }],
        botPresets: [],
        botPresetsId: 0,
        modules: [],
        pluginCustomStorage: {},
        characters: [{
            chaId: CHARACTER_ID,
            type: 'character',
            name: 'Ada',
            image: '',
            desc: '',
            firstMessage: 'Hello, this is the greeting.',
            alternateGreetings: [],
            chatPage: 0,
            chats: [{
                id: CHAT_ID,
                name: 'chat',
                note: '',
                localLore: [],
                message: Array.from({ length: HISTORY }, (_, index) => ({
                    role: index % 2 === 0 ? 'user' : 'char',
                    data: `message ${index}`,
                    chatId: `m-${String(index).padStart(3, '0')}`,
                })),
            }],
        }],
    } as unknown as Database
}

/** The unhydrated chat slot, exactly as a bootstrap leaves it. */
function reactiveCharacter(): character {
    const state = $state({
        chaId: CHARACTER_ID,
        name: 'Ada',
        image: '',
        chatPage: 0,
        chats: [{
            id: CHAT_ID,
            name: 'chat',
            note: '',
            localLore: [],
            message: [] as any[],
            _placeholder: true,
            messagesLoaded: false,
        }],
        alternateGreetings: [],
        firstMessage: 'Hello, this is the greeting.',
        emotionImages: [],
        customscript: [],
        globalLore: [],
    })
    return state as unknown as character
}

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
        RecordingIntersectionObserver.live = RecordingIntersectionObserver.live
            .filter(observer => observer !== this)
    }
    takeRecords(): IntersectionObserverEntry[] { return [] }
    reportVisible(selector: string) {
        const target = [...this.targets].find(candidate => candidate.matches(selector))
        if (!target) throw new Error(`no observed element matches ${selector}`)
        this.callback(
            [{ target, isIntersecting: true } as unknown as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
        )
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

let server: ServerHandle
let mounted: Record<string, any> | null = null
let host: HTMLDivElement | null = null

/** Boot a real server and migrate one long chat into its SQL database. */
beforeAll(async () => {
    server = await spawnServer()
    const anonymous = nodeFetch(server.port, null)
    const loginResponse = await anonymous('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: server.password }),
    })
    expect(loginResponse.ok).toBe(true)
    const { token } = await loginResponse.json() as { token: string }
    expect(typeof token).toBe('string')

    const storage = new NodeSqliteStorage(nodeFetch(server.port, token))
    expect(await storage.init()).toBe(true)
    expect(await storage.replaceDatabase(legacyDatabase())).toBe(true)
    activeStorage.current = storage
}, 60_000)

afterAll(async () => {
    activeStorage.current = null
    await server?.cleanup()
})

/** The screen as the app wires it: component, loader, and the link between them. */
async function openChat() {
    const currentCharacter = reactiveCharacter()
    DBState.db.characters = [currentCharacter as any]
    selectedCharID.set(0)
    await ensureChatMessageWindow(currentCharacter, 0, PAGE)
    const chat = currentCharacter.chats[0]

    const errors: unknown[] = []
    const loader = createOlderMessageLoader({
        hasOlder: () => hasOlderSqlMessages(currentCharacter.chats[currentCharacter.chatPage]),
        load: () => loadOlderChatMessages(currentCharacter, currentCharacter.chatPage, PAGE),
        onError: (error) => errors.push(error),
    })

    // `DefaultChatScreen` keeps this in a `$state` and reads it in the greeting
    // gate; it is fed only by the component's own window reports.
    let atOldestEnd = false
    let lastRequest: Promise<unknown> = Promise.resolve()
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
            onWindowChange: (state: { atOldestEnd: boolean }) => { atOldestEnd = state.atOldestEnd },
            onReachOldestMounted: () => { lastRequest = loader.request() },
        },
    }) as Record<string, any>
    flushSync()

    const observer = () => {
        const live = RecordingIntersectionObserver.live.at(-1)
        if (!live) throw new Error('the chat screen is not observing its scroll ends')
        return live
    }

    return {
        chat,
        errors,
        loader,
        /** The exact gate `DefaultChatScreen.svelte` draws the greeting behind. */
        greetingVisible: () => atOldestEnd && !hasOlderSqlMessages(chat),
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
    }
}

beforeEach(() => {
    RecordingIntersectionObserver.live = []
    vi.stubGlobal('IntersectionObserver', RecordingIntersectionObserver)
    RecordingAnimationFrames.reset()
    vi.stubGlobal('requestAnimationFrame', RecordingAnimationFrames.request)
    vi.stubGlobal('cancelAnimationFrame', RecordingAnimationFrames.cancel)
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

describe('scrolling to the top of a real chat', () => {
    it('reaches the start of history without a failed page, and opens the greeting', async () => {
        const screen = await openChat()
        expect(screen.chat.message).toHaveLength(PAGE)
        expect(hasOlderSqlMessages(screen.chat)).toBe(true)
        expect(screen.greetingVisible()).toBe(false)

        for (let guard = 0; guard < 40; guard += 1) {
            if (screen.greetingVisible()) break
            await screen.scrollOlder()
        }

        // Every page came back clean, including the terminal one. This is the
        // assertion the fixture could not make: the loader swallows the failure
        // into `onError`, which is what became a toast in front of the user.
        expect(screen.errors).toEqual([])
        expect(screen.chat.message).toHaveLength(HISTORY)
        expect(screen.chat.message.map((message: any) => message.chatId)).toEqual(
            Array.from({ length: HISTORY }, (_, index) => `m-${String(index).padStart(3, '0')}`),
        )
        expect(hasOlderSqlMessages(screen.chat)).toBe(false)
        // Both halves of the gate, from the real component and the real window.
        expect(screen.greetingVisible()).toBe(true)
        expect(screen.loader.loading).toBe(false)
    }, 60_000)
})
