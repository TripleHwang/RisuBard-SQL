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

    async function run(
        query: RealmBrowseQuery,
        handlers: { success: (result: BrowseResult<TCard>) => void; failure: (error: unknown) => void },
    ): Promise<void> {
        controller?.abort()
        controller = new AbortController()
        const requestController = controller
        const requestGeneration = ++generation
        try {
            const result = await fetcher(query, { signal: requestController.signal })
            if (requestGeneration !== generation || requestController.signal.aborted) return
            handlers.success(result)
            if (isDefaultRealmBrowseQuery(query)) {
                try {
                    await writeDefaultCache(result.cards)
                } catch {
                    // An unavailable local cache must not turn a fresh network result into a failure.
                }
            }
        } catch (error) {
            if (requestGeneration !== generation || requestController.signal.aborted) return
            handlers.failure(error)
        }
    }

    return {
        run,
        abort() {
            generation += 1
            controller?.abort()
            controller = null
        },
    }
}
