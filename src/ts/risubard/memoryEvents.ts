export const RISUBARD_MEMORY_UPDATED_EVENT =
    'risubard-memory-updated'

export interface RisuBardMemoryUpdatedDetail {
    characterId: string
    chatId: string
}

export function announceRisuBardMemoryUpdated(
    detail: RisuBardMemoryUpdatedDetail
): void {
    if (typeof window === 'undefined'
        || typeof CustomEvent === 'undefined') return
    window.dispatchEvent(new CustomEvent(
        RISUBARD_MEMORY_UPDATED_EVENT,
        { detail: { ...detail } }
    ))
}
