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

/** Dispatches URL-driven imports only when the complete database is writable. */
export async function dispatchStartupURLImport<T>(
    importer: () => T | Promise<T>,
): Promise<boolean> {
    let invoked = false
    const result = runStartupMutation(() => {
        invoked = true
        return importer()
    })
    if (!invoked) return false
    await result
    return true
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
