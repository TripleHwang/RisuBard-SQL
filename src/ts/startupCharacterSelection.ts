export type StartupCharacterSelection = {
    characterId: string
    index: number
}

type QueueSelectionArgs = {
    ready: boolean
    characterId: string
    index: number
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

    return {
        select({ ready, characterId, index, safeSelect, fullSelect }: QueueSelectionArgs): boolean {
            if (!ready) {
                safeSelect(index)
                pending = { characterId, index }
                return false
            }
            pending = null
            fullSelect(index)
            return true
        },

        resume({ ready, findIndex, fullSelect }: ResumeSelectionArgs): boolean {
            if (!ready || !pending) return false
            const selection = pending
            pending = null
            const index = findIndex(selection.characterId)
            if (index === -1) return false
            fullSelect(index)
            return true
        },
    }
}
