export type StartupCharacterSelection = {
    characterId: string
    index: number
}

type QueueSelectionArgs = {
    ready: boolean
    characterId: string
    index: number
    hydrate: (index: number) => Promise<boolean>
    findIndex: (characterId: string) => number
    safeSelect: (index: number) => void
    fullSelect: (index: number) => void
    onFailure?: () => void
}

type ResumeSelectionArgs = {
    ready: boolean
    findIndex: (characterId: string) => number
    fullSelect: (index: number) => void
}

/**
 * Defers startup activation, but never exposes a partially hydrated target.
 * `hydrate` represents the prerequisite graph for a selection; callers commit
 * the visible selection only after this queue returns the resolved index.
 */
export function createStartupCharacterSelectionQueue() {
    let pending: StartupCharacterSelection | null = null
    let selectionIntent = 0

    return {
        async select({ ready, characterId, index, hydrate, findIndex, safeSelect: _safeSelect, fullSelect, onFailure }: QueueSelectionArgs): Promise<boolean> {
            const intent = ++selectionIntent
            if (ready) pending = null
            else pending = { characterId, index }
            const failLatest = () => {
                if (intent !== selectionIntent) return
                if (pending?.characterId === characterId) pending = null
                onFailure?.()
            }
            let hydrated = false
            try {
                hydrated = await hydrate(index)
            } catch {
                failLatest()
                return false
            }
            if (!hydrated) {
                failLatest()
                return false
            }
            if (intent !== selectionIntent) return false
            const hydratedIndex = findIndex(characterId)
            if (hydratedIndex === -1) {
                failLatest()
                return false
            }
            if (!ready) return false
            pending = null
            fullSelect(hydratedIndex)
            return true
        },

        resume({ ready, findIndex, fullSelect }: ResumeSelectionArgs): boolean {
            if (!ready || !pending) return false
            const selection = pending
            pending = null
            selectionIntent++
            const index = findIndex(selection.characterId)
            if (index === -1) return false
            fullSelect(index)
            return true
        },

        cancel(): void {
            pending = null
            selectionIntent++
        },
    }
}
