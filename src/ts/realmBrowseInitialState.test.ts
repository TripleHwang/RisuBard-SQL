import { describe, expect, test } from 'vitest'
import { applyInitialDefaultCache, defaultRefreshFailedMessage, initialDefaultBrowseState } from './realmBrowseInitialState'

describe('initial RisuRealm SWR display state', () => {
    test('turns a cache hit before the refresh settles into a nonblocking refreshing state', () => {
        expect(applyInitialDefaultCache(initialDefaultBrowseState(), true)).toEqual({
            hasDefaultFeed: true,
            isLoading: false,
            isRefreshing: true,
            browseError: '',
        })
    })

    test('turns a cache hit after refresh failure into a stale-cache error state', () => {
        expect(applyInitialDefaultCache({
            hasDefaultFeed: false,
            isLoading: false,
            isRefreshing: false,
            browseError: 'Unable to load RisuRealm results. Please try again.',
        }, false)).toEqual({
            hasDefaultFeed: true,
            isLoading: false,
            isRefreshing: false,
            browseError: defaultRefreshFailedMessage,
        })
    })
})
