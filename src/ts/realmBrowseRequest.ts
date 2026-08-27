import type { RealmBrowseQuery } from './characterCards'
import { isDefaultRealmBrowseQuery } from './realmBrowseCache'

type BrowseResult<TCard> = { cards: TCard[]; additionalHTML: string }
type BrowseFetcher<TCard> = (query: RealmBrowseQuery, options?: { signal?: AbortSignal }) => Promise<BrowseResult<TCard>>

export function createRealmBrowseRequestCoordinator<TCard>(
    fetcher: BrowseFetcher<TCard>,
    writeDefaultCache: (cards: TCard[]) => Promise<void>,
) {
    let generation = 0
    let controller: AbortController | null = null
    let defaultWriteQueue = Promise.resolve()
    let initialDefaultIntentActive = true
    let initialDefaultNetworkLanded = false

    function queueDefaultCacheWrite(cards: TCard[]) {
        defaultWriteQueue = defaultWriteQueue.then(async () => {
            // Queue ordering makes the newest successful default response the final persisted value.
            try {
                await writeDefaultCache(cards)
            } catch {
                // An unavailable local cache must not turn a fresh network result into a failure.
            }
        })
    }

    async function run(
        query: RealmBrowseQuery,
        handlers: { success: (result: BrowseResult<TCard>) => void; failure: (error: unknown) => void },
    ): Promise<void> {
        if (!isDefaultRealmBrowseQuery(query)) initialDefaultIntentActive = false
        controller?.abort()
        controller = new AbortController()
        const requestController = controller
        const requestGeneration = ++generation
        try {
            const result = await fetcher(query, { signal: requestController.signal })
            if (requestGeneration !== generation || requestController.signal.aborted) return
            if (isDefaultRealmBrowseQuery(query) && initialDefaultIntentActive) initialDefaultNetworkLanded = true
            handlers.success(result)
            if (isDefaultRealmBrowseQuery(query)) {
                queueDefaultCacheWrite(result.cards)
            }
        } catch (error) {
            if (requestGeneration !== generation || requestController.signal.aborted) return
            handlers.failure(error)
        }
    }

    return {
        run,
        applyInitialDefaultCache(cache: Promise<TCard[] | null>, apply: (cards: TCard[]) => void) {
            void cache.then((cards) => {
                if (cards && initialDefaultIntentActive && !initialDefaultNetworkLanded) apply(cards)
            }).catch(() => undefined)
        },
        abort() {
            generation += 1
            initialDefaultIntentActive = false
            controller?.abort()
            controller = null
        },
    }
}
