/**
 * Recovery hook for deferred SQL startup, kept in a zero-import leaf module.
 *
 * `DeferredStartupGate` is imported while `App.svelte` is still evaluating, so
 * importing `bootstrap.ts` (and its whole module graph) straight from the
 * component would add a startup-time cycle risk for the sake of one function.
 * bootstrap registers its implementation here instead.
 */
type DeferredStartupRetry = () => Promise<boolean>

let retryHandler: DeferredStartupRetry | null = null

export function registerDeferredStartupRetry(retry: DeferredStartupRetry | null): void {
    retryHandler = retry
}

/** False when this session never scheduled deferred hydration at all. */
export function canRetryDeferredSqlStartup(): boolean {
    return retryHandler !== null
}

export async function retryDeferredSqlStartup(): Promise<boolean> {
    if (!retryHandler) return false
    return retryHandler()
}
