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
}

type ResumeSelectionArgs = {
    ready: boolean
    findIndex: (characterId: string) => number
    fullSelect: (index: number) => void
}

/** Keeps safe-shell selection responsive while holding full chat activation for the complete graph. */
export function createStartupCharacterSelectionQueue() {
    let pending: StartupCharacterSelection | null = null
    let selectionIntent = 0

    return {
        async select({ ready, characterId, index, hydrate, findIndex, safeSelect, fullSelect }: QueueSelectionArgs): Promise<boolean> {
            const intent = ++selectionIntent
            if (ready) {
                pending = null
                fullSelect(index)
                return true
            }
            pending = { characterId, index }
            let hydrated = false
            try {
                hydrated = await hydrate(index)
            } catch {
                return false
            }
            if (!hydrated || intent !== selectionIntent) return false
            const hydratedIndex = findIndex(characterId)
            if (hydratedIndex === -1) return false
            safeSelect(hydratedIndex)
            return false
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
    }
}
