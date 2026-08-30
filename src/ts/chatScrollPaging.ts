/**
 * The gate between "the user scrolled to the oldest message on screen" and
 * "fetch the page before it".
 *
 * A button pressed this once per press. Scrolling does not: an
 * IntersectionObserver reports the same sentinel repeatedly inside a single
 * flick, and every report arrives while the previous fetch is still in the air.
 * Two `loadOlderChatMessages` calls running together against one chat would
 * both validate against the same window and both splice into the same array, so
 * requests are coalesced rather than queued -- there is nothing useful about
 * the second page of a burst that the first one does not already deliver.
 */

export type OlderMessageLoadOutcome =
    /** A page was fetched and merged. */
    | 'loaded'
    /** A fetch was already in the air; this request rode along with it. */
    | 'coalesced'
    /** Storage holds nothing older. A normal stop, not a failure. */
    | 'exhausted'
    /** The fetch was attempted and rejected; `onError` has been told. */
    | 'failed'

export interface OlderMessageLoader {
    /** True only while a fetch is actually in the air. */
    readonly loading: boolean
    request(): Promise<OlderMessageLoadOutcome>
}

export interface OlderMessageLoaderOptions {
    /**
     * Whether storage holds messages older than the resident ones. Read at the
     * moment of the request, never cached: a page that has just landed changes
     * the answer.
     */
    hasOlder: () => boolean
    load: () => Promise<unknown>
    /**
     * Raised only around a real fetch. Reaching the start of the history must
     * never raise it -- nothing would be coming to lower it again, and a
     * spinner nobody can resolve is indistinguishable to a user from a hang.
     */
    onLoadingChange?: (loading: boolean) => void
    /**
     * A rejected fetch is reported here, never swallowed. `loadOlderChatMessages`
     * rejects when a page fails its contiguity or identity validation, which is
     * exactly the case a user has to be able to see and report.
     */
    onError?: (error: unknown) => void
}

export function createOlderMessageLoader(options: OlderMessageLoaderOptions): OlderMessageLoader {
    let inFlight: Promise<OlderMessageLoadOutcome> | null = null
    let loading = false

    const setLoading = (next: boolean) => {
        if (loading === next) return
        loading = next
        options.onLoadingChange?.(next)
    }

    return {
        get loading() {
            return loading
        },
        request(): Promise<OlderMessageLoadOutcome> {
            // Synchronous from here to the assignment below, so two reports in
            // the same task can never both open a fetch.
            if (inFlight) return inFlight.then(() => 'coalesced' as const)
            if (!options.hasOlder()) return Promise.resolve('exhausted' as const)

            setLoading(true)
            const started = (async (): Promise<OlderMessageLoadOutcome> => {
                try {
                    await options.load()
                    return 'loaded'
                } catch (error) {
                    options.onError?.(error)
                    return 'failed'
                }
            })()
            inFlight = started
            // Cleared from a later microtask rather than a `finally` inside the
            // body: a `load` that throws before its first suspension runs the
            // body's `finally` *before* `inFlight` is assigned, which would leave
            // the loader permanently refusing every later request.
            void started.then(() => {
                if (inFlight !== started) return
                inFlight = null
                setLoading(false)
            })
            return started
        },
    }
}
