export const defaultRefreshFailedMessage = 'Showing saved RisuRealm results. Refresh failed.'

export type DefaultBrowseUiState = {
    hasDefaultFeed: boolean
    isLoading: boolean
    isRefreshing: boolean
    browseError: string
}

export function initialDefaultBrowseState(): DefaultBrowseUiState {
    return { hasDefaultFeed: false, isLoading: true, isRefreshing: false, browseError: '' }
}

export function applyInitialDefaultCache(state: DefaultBrowseUiState, initialRefreshPending: boolean): DefaultBrowseUiState {
    return {
        hasDefaultFeed: true,
        isLoading: false,
        isRefreshing: initialRefreshPending,
        browseError: initialRefreshPending ? '' : state.browseError ? defaultRefreshFailedMessage : '',
    }
}
