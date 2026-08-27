import { get } from 'svelte/store'
import { startupHydrationErrorStore, startupHydrationStore } from './stores.svelte'

/** Shared source-level guard for mutations that require deferred SQL domains. */
export function isStartupMutationReady(): boolean {
    return !get(startupHydrationStore) && !get(startupHydrationErrorStore)
}

export function runStartupMutation<T>(mutation: () => T): T | undefined {
    if (!isStartupMutationReady()) return undefined
    return mutation()
}

export function scheduleAfterTwoAnimationFrames(
    task: () => void | Promise<void>,
    requestFrame: (callback: FrameRequestCallback) => number = typeof globalThis.requestAnimationFrame === 'function'
        ? globalThis.requestAnimationFrame.bind(globalThis)
        : (callback) => globalThis.setTimeout(callback, 0) as unknown as number,
): void {
    const run = () => {
        void Promise.resolve().then(task).catch(console.error)
    }
    requestFrame(() => requestFrame(run))
}
