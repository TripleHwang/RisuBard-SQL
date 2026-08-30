import { untrack } from 'svelte'

/**
 * Per-component lazy loading.
 *
 * A component says "I need this, load it when I appear, and tell me whether it
 * is loading, ready or failed", and gets back a handle it can render from. The
 * loading and the failure both live in that component's own subtree; nothing
 * here touches a global overlay, and nothing here can make the rest of the app
 * unclickable while one surface is fetching.
 *
 * Two rules shape the whole module.
 *
 * FAILURE IS A STATE, NOT A DEFAULT. There is no path from "the load failed"
 * to a value. `value` stays `undefined`, `status` becomes `'failed'`, and the
 * error object is kept. A consumer that renders `resource.value ?? []` on a
 * failed load is telling the user "there are none of these", which is a
 * different claim from "we could not find out", and a user who believes the
 * first one will act on it -- delete the empty thing, re-create what is already
 * there, export a file that is missing half its content. `LazyState.svelte`
 * renders the failure branch by default for exactly this reason: forgetting to
 * write one produces a visible error, not a convincing empty list.
 *
 * ONE IN-FLIGHT LOAD PER KEY. Modelled on `ensureRootKeyHydrated` /
 * `ensureCharacterHydrated` in
 * `src/ts/storage/sql/sqlRuntimeHydration.ts`: concurrent callers for the same
 * key share the same promise rather than each firing their own request, and
 * the slot is freed once it settles so a failure is retryable. That pattern
 * already exists in the storage layer; this is the same pattern reused, not a
 * second one invented alongside it.
 */

export type LazyStatus = 'idle' | 'loading' | 'ready' | 'failed'

/**
 * Deliberately a plain module-level `Map`, NOT `$state`.
 *
 * Svelte's `proxy()` returns any value whose prototype is neither
 * `Object.prototype` nor `Array.prototype` untouched, so `$state(new Map())` is
 * left unproxied and its mutations signal nothing. Reactivity lives on the
 * per-instance `$state` fields of `LazyResource` instead, where it actually
 * works; this map is pure bookkeeping about who is already fetching what.
 */
const inFlight = new Map<string, Promise<unknown>>()

/**
 * Share one in-flight load per `key`. A rejection is shared too, and the slot
 * is freed either way so a later call can retry.
 *
 * The slot is freed from `.then(release, release)` rather than a `finally`
 * inside the loader body: a loader that throws synchronously would otherwise
 * run its cleanup before `inFlight.set` had happened, stranding a permanently
 * rejected promise in the map and turning one transport failure into a
 * key that can never be loaded again for the life of the session.
 */
export function sharedLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key)
    if (existing) return existing as Promise<T>
    const started = (async () => load())()
    inFlight.set(key, started)
    const release = () => {
        if (inFlight.get(key) === started) inFlight.delete(key)
    }
    started.then(release, release)
    return started
}

/** True while some `LazyResource` (or direct `sharedLoad` caller) holds `key`. */
export function isLazyLoadInFlight(key: string): boolean {
    return inFlight.has(key)
}

/** Full reset of the shared in-flight map. Tests need this; nothing else does. */
export function resetLazyLoadsForTesting(): void {
    inFlight.clear()
}

export interface LazyResourceConfig<T> {
    /**
     * Namespace for the shared in-flight map. Two surfaces that both key on a
     * character id but load different things must not share a promise, so the
     * scope is part of the identity, not just the key.
     */
    scope: string
    /**
     * What this resource currently needs, or `null` for "nothing to load yet"
     * (a closed dialog, no selected character, a control whose precondition is
     * not met). Read reactively: when it changes, the previous value stops
     * describing what the component is asking for and is dropped.
     */
    key: () => string | null
    /** Loads the thing. Must reject on failure -- never resolve a fallback. */
    load: (key: string) => Promise<T>
    /**
     * `true` (the default) requests as soon as the key becomes non-null, which
     * is what "load it when I appear" means. Requires construction during
     * component initialisation, because it installs an `$effect`.
     *
     * `false` leaves the resource idle until something calls `request()` --
     * for controls the user presses rather than surfaces that appear.
     */
    auto?: boolean
    /**
     * Called with the error before it is stored. The default logs it. A
     * surface that also wants a toast passes one; nothing may pass a handler
     * that swallows the error, because the error is stored regardless.
     */
    onError?: (error: unknown, key: string) => void
}

export class LazyResource<T> {
    #status = $state<LazyStatus>('idle')
    #value = $state<T | undefined>(undefined)
    #error = $state<unknown>(undefined)
    /** The key the current status/value/error describes. */
    #stateKey = $state<string | null>(null)
    /**
     * Monotonic request counter. A load that finishes after the component has
     * moved on -- the user switched characters, closed the dialog, pressed the
     * control again -- must not write its result over the newer request's.
     */
    #token = 0
    #config: LazyResourceConfig<T>

    constructor(config: LazyResourceConfig<T>) {
        this.#config = config
    }

    get status(): LazyStatus { return this.#status }
    get loading(): boolean { return this.#status === 'loading' }
    get failed(): boolean { return this.#status === 'failed' }
    get ready(): boolean { return this.#status === 'ready' }
    /** Defined only while `status === 'ready'`. Never a fallback for a failure. */
    get value(): T | undefined { return this.#status === 'ready' ? this.#value : undefined }
    get error(): unknown { return this.#error }
    /** The key whose outcome `status`/`value`/`error` describe. */
    get stateKey(): string | null { return this.#stateKey }

    /**
     * Whether this resource requests on its own as soon as its key appears.
     *
     * This is what tells a renderer what `'idle'` MEANS, and the two meanings
     * are opposites. For an auto resource, idle is the single instant before
     * the effect fires, so painting real content there flashes an empty state
     * and the loading branch is right. For a manual one -- an opener behind a
     * button -- idle is the resting state, the honest reading is "nothing has
     * been asked for", and showing the loading branch there is a spinner that
     * never stops, sitting above a list nobody has touched.
     */
    get autoRequests(): boolean { return this.#config.auto !== false }

    /** Human-readable failure text, for the default failure branch. */
    get errorMessage(): string {
        const error = this.#error
        if (error === undefined || error === null) return ''
        if (error instanceof Error) return error.message || String(error)
        return String(error)
    }

    /**
     * Load the current key if it is not already loaded or loading.
     *
     * Never rejects: the failure is the `'failed'` status plus the retained
     * error, which is what the component renders. Returning a promise that
     * resolves to nothing on failure is also why there is no `value` to
     * accidentally default -- a caller cannot write `await r.request() ?? []`.
     */
    async request(): Promise<void> {
        const key = untrack(() => this.#config.key())
        if (key === null) {
            this.#resetTo(null)
            return
        }
        if (this.#stateKey === key && (this.#status === 'ready' || this.#status === 'loading')) {
            // Already answered or already being answered for this exact key.
            // Join the in-flight promise so callers can await completion.
            const pending = inFlight.get(this.#sharedKey(key))
            if (pending) { await pending.catch(() => {}) }
            return
        }
        await this.#start(key)
    }

    /**
     * Load again from scratch, discarding whatever the last attempt concluded.
     * This is the Retry button: it is the only way out of `'failed'`, and it is
     * also correct on `'ready'` when the caller wants fresh data.
     */
    async retry(): Promise<void> {
        const key = untrack(() => this.#config.key())
        if (key === null) {
            this.#resetTo(null)
            return
        }
        await this.#start(key)
    }

    /**
     * Drop everything this resource concluded and return to `'idle'`. Used when
     * a surface closes: the next open must not paint a stale failure, or a
     * stale success for a key that has since changed underneath it.
     */
    reset(): void {
        this.#token += 1
        this.#resetTo(null)
    }

    #sharedKey(key: string): string {
        return `${this.#config.scope}::${key}`
    }

    #resetTo(key: string | null): void {
        this.#status = 'idle'
        this.#value = undefined
        this.#error = undefined
        this.#stateKey = key
    }

    async #start(key: string): Promise<void> {
        const token = ++this.#token
        this.#status = 'loading'
        // The previous value described a request this one supersedes. Keeping
        // it would let a surface render last character's personas under this
        // character's name for the length of a fetch.
        this.#value = undefined
        this.#error = undefined
        this.#stateKey = key
        try {
            const value = await sharedLoad(this.#sharedKey(key), () => this.#config.load(key))
            if (token !== this.#token) return
            this.#value = value
            this.#error = undefined
            this.#status = 'ready'
        } catch (error) {
            // Reported even when superseded: a load that failed really did
            // fail, and losing that to a race is exactly the silent failure
            // this module exists to prevent.
            if (this.#config.onError) this.#config.onError(error, key)
            else console.error(`[lazy ${this.#config.scope}] load failed for "${key}":`, error)
            if (token !== this.#token) return
            this.#error = error
            this.#value = undefined
            this.#status = 'failed'
        }
    }

    /** @internal wired by `createLazyResource` when `auto` is on. */
    syncToKey(key: string | null): void {
        if (key === null) {
            if (this.#stateKey !== null || this.#status !== 'idle') this.reset()
            return
        }
        if (this.#stateKey === key && this.#status !== 'idle') return
        void this.#start(key)
    }
}

/**
 * Create a resource for a component.
 *
 * With `auto` on (the default) this installs an `$effect`, so it must be called
 * during component initialisation -- the same place `$derived` goes. The effect
 * reads only `config.key()`; every read of the resource's own state inside it
 * is untracked, or writing the status would re-trigger the effect that wrote it.
 */
export function createLazyResource<T>(config: LazyResourceConfig<T>): LazyResource<T> {
    const resource = new LazyResource(config)
    if (config.auto !== false) {
        $effect(() => {
            const key = config.key()
            untrack(() => resource.syncToKey(key))
        })
    }
    return resource
}
