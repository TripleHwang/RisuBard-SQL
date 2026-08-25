import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('model favorites', () => {
    beforeEach(() => {
        vi.resetModules()
        localStorage.clear()
    })

    it('persists only non-empty model ids locally', async () => {
        const { modelFavoritesStore } = await import('./modelFavorites.svelte')
        modelFavoritesStore.toggle('openai_gpt-5')
        modelFavoritesStore.toggle('')

        expect(modelFavoritesStore.favorites).toEqual(['openai_gpt-5'])
        expect(JSON.parse(localStorage.getItem('risu_favorite_models') ?? '[]')).toEqual(['openai_gpt-5'])
    })

    it('loads a compatible saved favorites list and removes a favorite', async () => {
        localStorage.setItem('risu_favorite_models', JSON.stringify(['model-a', '', 42, 'model-b']))
        const { modelFavoritesStore } = await import('./modelFavorites.svelte')

        expect(modelFavoritesStore.favorites).toEqual(['model-a', 'model-b'])
        modelFavoritesStore.toggle('model-a')
        expect(modelFavoritesStore.favorites).toEqual(['model-b'])
    })
})
