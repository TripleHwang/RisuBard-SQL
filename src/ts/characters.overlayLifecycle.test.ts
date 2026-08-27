import { describe, expect, test, vi, beforeEach } from 'vitest'
import { get } from 'svelte/store'

const hydrateCharacter = vi.fn()
let startupReady = true

vi.mock('./storage/sql/sqlRuntimeHydration', () => ({
    ensureCharacterHydrated: (...a: any[]) => hydrateCharacter(...a),
    ensureChatMessageWindow: vi.fn(),
    loadOlderChatMessages: vi.fn(),
}))
vi.mock('./startupReadiness', () => ({
    isStartupMutationReady: () => startupReady,
}))
const alertError = vi.fn()
vi.mock('./alert', async (orig) => ({ ...(await (orig() as any)), alertError: (...a: any[]) => alertError(...a) }))

const makeChar = (id: string) => ({
    chaId: id, name: id, type: 'character', detailsLoaded: false, chatPage: 0, globalLore: [],
    chats: [{ id: `${id}-chat`, name: 'c', message: [] }],
})

describe('loadingOverlayStore lifecycle around startup character selection', () => {
    beforeEach(async () => {
        const { startupHydrationErrorStore, startupHydrationStore, selectedCharID } = await import('./stores.svelte')
        hydrateCharacter.mockReset()
        alertError.mockReset()
        startupReady = true
        startupHydrationStore.set(false)
        startupHydrationErrorStore.set(false)
        selectedCharID.set(-1)
        // Same budget as the tests: the first dynamic import pulls the whole
        // store graph, which can outrun the 10s default hook timeout when the
        // full suite is transforming in parallel.
    }, 120000)

    test('startup-ready selection whose hydration REJECTS clears the overlay', async () => {
        const { setDatabaseLite } = await import('./storage/database.svelte')
        const { loadingOverlayStore } = await import('./stores.svelte')
        const { changeChar } = await import('./characters')

        setDatabaseLite({ characters: [makeChar('a')] } as any)
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        hydrateCharacter.mockRejectedValue(new Error('SQL character repair could not recover this character'))

        await changeChar(0)

        expect(alertError).toHaveBeenCalledTimes(1)
        expect(get(loadingOverlayStore).active).toBe(false)
    }, 120000)

    test('a deferred selection that can never be resumed must not strand the overlay', async () => {
        const { setDatabaseLite } = await import('./storage/database.svelte')
        const { loadingOverlayStore } = await import('./stores.svelte')
        const { changeChar } = await import('./characters')

        setDatabaseLite({ characters: [makeChar('a')] } as any)
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        // Deferred SQL startup failed: startupHydrationStore stays true, so
        // isStartupMutationReady() is false forever and bootstrap.ts will never
        // call resumeDeferredCharacterSelection() again.
        startupReady = false
        hydrateCharacter.mockImplementation(async (db: any, i: number) => {
            db.characters[i].detailsLoaded = true
            return db.characters[i]
        })

        await changeChar(0)

        // FAILS TODAY: a full-screen `fixed inset-0 z-[60]` overlay is left
        // mounted and eats every click in the app.
        expect(get(loadingOverlayStore).active).toBe(false)
    }, 120000)

    test('resumeDeferredCharacterSelection() that finds nothing must not strand the overlay', async () => {
        const { setDatabaseLite } = await import('./storage/database.svelte')
        const { loadingOverlayStore } = await import('./stores.svelte')
        const { changeChar, resumeDeferredCharacterSelection } = await import('./characters')

        setDatabaseLite({ characters: [makeChar('a')] } as any)
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        startupReady = false
        hydrateCharacter.mockImplementation(async (db: any, i: number) => {
            db.characters[i].detailsLoaded = true
            return db.characters[i]
        })
        await changeChar(0)

        // Deferred hydration finished, but the queued character is gone.
        startupReady = true
        setDatabaseLite({ characters: [makeChar('b')] } as any)

        await expect(resumeDeferredCharacterSelection()).resolves.toBe(false)
        // FAILS TODAY.
        expect(get(loadingOverlayStore).active).toBe(false)
    }, 120000)

    test('a selection refused after a declined startup retry queues nothing and shows no overlay', async () => {
        const { setDatabaseLite } = await import('./storage/database.svelte')
        const { loadingOverlayStore, startupHydrationStore, startupHydrationErrorStore, selectedCharID } = await import('./stores.svelte')
        const { changeChar, resumeDeferredCharacterSelection } = await import('./characters')

        setDatabaseLite({ characters: [makeChar('a')] } as any)
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        // Exactly the state bootstrap.ts leaves behind when the user declines
        // the deferred-startup retry prompt: hydration never completes and
        // resumeDeferredCharacterSelection() is never called again.
        startupReady = false
        startupHydrationStore.set(true)
        startupHydrationErrorStore.set(true)

        await changeChar(0)

        expect(hydrateCharacter).not.toHaveBeenCalled()
        expect(alertError).toHaveBeenCalledTimes(1)
        expect(get(loadingOverlayStore).active).toBe(false)
        expect(get(selectedCharID)).toBe(-1)
        // Nothing was parked, so a later resume has nothing to strand.
        await expect(resumeDeferredCharacterSelection()).resolves.toBe(false)
        expect(get(loadingOverlayStore).active).toBe(false)
    }, 120000)

    test('the app recovers once the declined startup error is retried and cleared', async () => {
        const { setDatabaseLite } = await import('./storage/database.svelte')
        const { loadingOverlayStore, startupHydrationStore, startupHydrationErrorStore, selectedCharID } = await import('./stores.svelte')
        const { changeChar } = await import('./characters')

        setDatabaseLite({ characters: [makeChar('a')] } as any)
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        hydrateCharacter.mockImplementation(async (db: any, i: number) => {
            db.characters[i].detailsLoaded = true
            return db.characters[i]
        })
        startupReady = false
        startupHydrationStore.set(true)
        startupHydrationErrorStore.set(true)
        await changeChar(0)
        expect(get(selectedCharID)).toBe(-1)

        // What DeferredStartupGate's retry button does through
        // retryDeferredSqlStartup(): reopen the gate, then hydrate.
        startupHydrationErrorStore.set(false)
        startupHydrationStore.set(false)
        startupReady = true

        await changeChar(0)

        expect(get(selectedCharID)).toBe(0)
        expect(get(loadingOverlayStore).active).toBe(false)
    }, 120000)

    test('a refused selection takes down the overlay an in-flight one was holding', async () => {
        const { setDatabaseLite } = await import('./storage/database.svelte')
        const { loadingOverlayStore, startupHydrationStore, startupHydrationErrorStore, selectedCharID } = await import('./stores.svelte')
        const { changeChar } = await import('./characters')

        setDatabaseLite({ characters: [makeChar('a')] } as any)
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        let releaseHydration: () => void = () => {}
        hydrateCharacter.mockImplementation((db: any, i: number) => new Promise((resolve) => {
            releaseHydration = () => {
                db.characters[i].detailsLoaded = true
                resolve(db.characters[i])
            }
        }))

        const inFlight = changeChar(0)
        await Promise.resolve()
        expect(get(loadingOverlayStore).active).toBe(true)

        // Deferred startup fails while that selection is still loading, and the
        // user clicks again. The refusal owns the newest intent, so the older
        // selection's own cleanup will (correctly) decline to touch the overlay.
        startupReady = false
        startupHydrationStore.set(true)
        startupHydrationErrorStore.set(true)
        await changeChar(0)

        expect(get(loadingOverlayStore).active).toBe(false)
        releaseHydration()
        await inFlight
        expect(get(loadingOverlayStore).active).toBe(false)
        expect(get(selectedCharID)).toBe(-1)
    }, 120000)

    test('cancelling the overlay releases it without half-selecting a character', async () => {
        const { setDatabaseLite } = await import('./storage/database.svelte')
        const { loadingOverlayStore, selectedCharID } = await import('./stores.svelte')
        const { changeChar } = await import('./characters')

        setDatabaseLite({ characters: [makeChar('a')] } as any)
        loadingOverlayStore.set({ active: false, text: '', onCancel: null })
        let releaseHydration: (value: any) => void = () => {}
        hydrateCharacter.mockImplementation((db: any, i: number) => new Promise((resolve) => {
            releaseHydration = () => {
                db.characters[i].detailsLoaded = true
                resolve(db.characters[i])
            }
        }))

        const selection = changeChar(0)
        await Promise.resolve()
        expect(get(loadingOverlayStore).active).toBe(true)
        const cancel = get(loadingOverlayStore).onCancel
        expect(typeof cancel).toBe('function')

        cancel?.()
        expect(get(loadingOverlayStore).active).toBe(false)

        // The abandoned load must not come back and commit itself later.
        releaseHydration(undefined)
        await selection
        expect(get(loadingOverlayStore).active).toBe(false)
        expect(get(selectedCharID)).toBe(-1)
    }, 120000)
})
