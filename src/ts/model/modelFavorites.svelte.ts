const FAVORITES_STORAGE_KEY = 'risu_favorite_models'

function readFavorites(): string[] {
    try {
        if (typeof localStorage === 'undefined') return []
        const value = JSON.parse(localStorage.getItem(FAVORITES_STORAGE_KEY) ?? '[]')
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    } catch {
        return []
    }
}

function persistFavorites(favorites: readonly string[]): void {
    try {
        if (typeof localStorage !== 'undefined') {
            localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favorites))
        }
    } catch {
        // Storage can be unavailable in private browsing or embedded webviews.
    }
}

/** Local-only model shortcuts.  Model ids stay portable across database backups. */
class ModelFavoritesStore {
    favorites = $state<string[]>(readFavorites())

    isFavorite(modelId: string): boolean {
        return !!modelId && this.favorites.includes(modelId)
    }

    toggle(modelId: string): void {
        if (!modelId) return
        this.favorites = this.isFavorite(modelId)
            ? this.favorites.filter((id) => id !== modelId)
            : [...this.favorites, modelId]
        persistFavorites($state.snapshot(this.favorites))
    }
}

export const modelFavoritesStore = new ModelFavoritesStore()
