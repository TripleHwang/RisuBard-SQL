import { writable } from 'svelte/store'
import { observeLongTasks } from './startupMetrics'

export type SaverModeState = 'normal' | 'entering' | 'saver' | 'leaving'
export type SaverReason = 'import' | 'export' | 'cache-budget' | 'long-task' | 'background'

type SaverActions = {
    flush: () => Promise<void>
    evictChats: () => Promise<void>
    setWindow: (limit: 40 | 60) => void
    clearCaches: () => void
    now?: () => number
    isVisible?: () => boolean
    isFocused?: () => boolean
    scopeCount?: () => number
    onState?: (state: SaverModeState) => void
    setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/** Owners are deliberately callbacks, never values, so reclamation cannot retain cache contents. */
export class ReclaimableCacheRegistry {
    private owners = new Set<() => void>()

    register(clear: () => void): () => void {
        this.owners.add(clear)
        return () => this.owners.delete(clear)
    }

    clear(): void {
        for (const clear of this.owners) {
            try { clear() } catch (error) { console.warn('[saver] cache clear failed', error) }
        }
    }
}

/** Serialized saver-state transitions; a rejected flush intentionally changes nothing. */
export class SaverModeCoordinator {
    private transition: Promise<unknown> = Promise.resolve()
    private _state: SaverModeState = 'normal'
    private _scopeCount = 0
    private visibleFocusedSince: number | null = null
    private longTasks: number[] = []
    private leaveTimer: ReturnType<typeof setTimeout> | null = null
    private retryTimer: ReturnType<typeof setTimeout> | null = null

    constructor(private readonly actions: SaverActions) {}

    get state(): SaverModeState { return this._state }
    get scopeCount(): number { return this.actions.scopeCount?.() ?? this._scopeCount }

    private setState(state: SaverModeState): void {
        this._state = state
        this.actions.onState?.(state)
    }

    private setTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
        return (this.actions.setTimer ?? setTimeout)(callback, delay) as ReturnType<typeof setTimeout>
    }

    private clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
        if (timer !== null) (this.actions.clearTimer ?? clearTimeout)(timer)
    }

    private scheduleLeave(): void {
        this.clearTimer(this.leaveTimer)
        this.leaveTimer = null
        if (this._state !== 'saver' || !this.visibleAndFocused() || this.scopeCount > 0) return
        this.visibleFocusedSince ??= this.now()
        const remaining = Math.max(0, 30_000 - (this.now() - this.visibleFocusedSince))
        this.leaveTimer = this.setTimer(() => { this.leaveTimer = null; void this.tryLeave() }, remaining)
    }

    private scheduleRetry(reason: SaverReason): void {
        if (this.retryTimer !== null) return
        this.retryTimer = this.setTimer(() => {
            this.retryTimer = null
            void this.enter(reason).catch(() => undefined)
        }, 5_000)
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const next = this.transition.then(operation, operation)
        this.transition = next.then(() => undefined, () => undefined)
        return next
    }

    async enter(_reason: SaverReason): Promise<void> {
        return this.enqueue(async () => {
            if (this._state === 'saver') {
                // A new pressure signal restarts the quiet-period hysteresis.
                this.visibleFocusedSince = null
                this.clearTimer(this.leaveTimer)
                this.leaveTimer = null
                this.scheduleLeave()
                return
            }
            this.setState('entering')
            try {
                await this.actions.flush()
                await this.actions.evictChats()
                this.actions.setWindow(40)
                this.actions.clearCaches()
                this.visibleFocusedSince = this.visibleAndFocused() ? this.now() : null
                this.setState('saver')
                this.scheduleLeave()
            } catch (error) {
                // Every entering action is best-effort but all failures must
                // release the transition state and retry later.
                this.setState('normal')
                this.scheduleRetry(_reason)
                throw error
            }
        })
    }

    async tryLeave(): Promise<boolean> {
        return this.enqueue(async () => {
            if (this._state !== 'saver') return false
            if (!this.visibleAndFocused() || this.scopeCount > 0) {
                this.visibleFocusedSince = null
                this.scheduleLeave()
                return false
            }
            this.visibleFocusedSince ??= this.now()
            if (this.now() - this.visibleFocusedSince < 30_000) return false
            this.setState('leaving')
            try {
                this.actions.setWindow(60)
                this.setState('normal')
                this.clearTimer(this.leaveTimer)
                this.leaveTimer = null
                return true
            } catch (error) {
                // The saver DOM/store remains authoritative until the normal
                // window can be restored successfully.
                this.setState('saver')
                this.visibleFocusedSince = this.now()
                this.scheduleLeave()
                throw error
            }
        })
    }

    noteLifecycleChange(): void {
        if (!this.visibleAndFocused() || this.scopeCount > 0) this.visibleFocusedSince = null
        this.scheduleLeave()
    }

    async withScope<T>(_reason: Extract<SaverReason, 'import' | 'export'>, operation: () => Promise<T>): Promise<T> {
        this._scopeCount += 1
        this.visibleFocusedSince = null
        try {
            await this.enter(_reason)
            return await operation()
        } finally {
            this._scopeCount -= 1
            this.noteLifecycleChange()
        }
    }

    recordLongTask(duration: number): void {
        if (duration <= 100) return
        const cutoff = this.now() - 60_000
        this.longTasks = this.longTasks.filter(time => time >= cutoff)
        this.longTasks.push(this.now())
        if (this.longTasks.length >= 2) void this.enter('long-task').catch(() => undefined)
    }

    private now(): number { return this.actions.now?.() ?? Date.now() }
    private visibleAndFocused(): boolean {
        return (this.actions.isVisible?.() ?? true) && (this.actions.isFocused?.() ?? true)
    }
}

export const saverModeStore = writable(false)
export const reclaimableCaches = new ReclaimableCacheRegistry()
let runtimeCacheOwnersRegistered = false

/** Called once from bootstrap so module imports never retain cache ownership implicitly. */
export function registerRuntimeCacheOwners(...owners: Array<() => void>): void {
    if (runtimeCacheOwnersRegistered) return
    runtimeCacheOwnersRegistered = true
    for (const owner of owners) reclaimableCaches.register(owner)
}
let flushRuntimeDirtyChanges: () => Promise<void> = async () => undefined
let evictRuntimeChats: () => Promise<void> = async () => undefined
export const saverMode = new SaverModeCoordinator({
    flush: () => flushRuntimeDirtyChanges(),
    evictChats: () => evictRuntimeChats(),
    setWindow: () => undefined,
    clearCaches: () => reclaimableCaches.clear(),
    isVisible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    isFocused: () => typeof document === 'undefined' || document.hasFocus(),
    onState: state => saverModeStore.set(state === 'saver'),
})

/** Kept explicit to avoid storage/bootstrap import cycles during cold start. */
export function configureSaverModeActions(actions: Pick<SaverActions, 'flush' | 'evictChats'>): void {
    flushRuntimeDirtyChanges = actions.flush
    evictRuntimeChats = actions.evictChats
}

export function withSaverScope<T>(reason: Extract<SaverReason, 'import' | 'export'>, operation: () => Promise<T>): Promise<T> {
    return saverMode.withScope(reason, operation)
}

/** Deterministic quota/cache owners call this instead of relying on performance.memory. */
export function notifySaverCachePressure(): void {
    void saverMode.enter('cache-budget').catch(() => undefined)
}

let lifecycleInstalled = false
let lifecycleCleanup: (() => void) | undefined

/** Idempotent browser-only lifecycle/long-task wiring. */
export function installSaverModeLifecycle(): () => void {
    if (lifecycleInstalled) return lifecycleCleanup ?? (() => undefined)
    if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined
    lifecycleInstalled = true
    const enterBackground = () => { void saverMode.enter('background').catch(() => undefined) }
    const maybeLeave = () => { saverMode.noteLifecycleChange(); void saverMode.tryLeave() }
    const observer = observeLongTasks(entry => saverMode.recordLongTask(entry.duration))
    function visibilityChange(): void { document.visibilityState === 'hidden' ? enterBackground() : maybeLeave() }
    document.addEventListener('visibilitychange', visibilityChange)
    window.addEventListener('pagehide', enterBackground)
    window.addEventListener('freeze', enterBackground)
    window.addEventListener('focus', maybeLeave)
    window.addEventListener('blur', maybeLeave)
    lifecycleCleanup = () => {
        observer.disconnect()
        lifecycleInstalled = false
        lifecycleCleanup = undefined
        document.removeEventListener('visibilitychange', visibilityChange)
        window.removeEventListener('pagehide', enterBackground)
        window.removeEventListener('freeze', enterBackground)
        window.removeEventListener('focus', maybeLeave)
        window.removeEventListener('blur', maybeLeave)
    }
    return lifecycleCleanup
}
