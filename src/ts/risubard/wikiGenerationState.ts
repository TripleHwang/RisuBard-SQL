import { derived, writable } from 'svelte/store'

export const wikiGenerationOperations = writable<Set<string>>(new Set())
export const isWikiGenerating = derived(
    wikiGenerationOperations,
    (operations) => operations.size > 0
)

export function beginWikiGeneration(operationId: string): void {
    if (!operationId) return
    wikiGenerationOperations.update((operations) => {
        if (operations.has(operationId)) return operations
        const next = new Set(operations)
        next.add(operationId)
        return next
    })
}

export function endWikiGeneration(operationId: string): void {
    wikiGenerationOperations.update((operations) => {
        if (!operations.has(operationId)) return operations
        const next = new Set(operations)
        next.delete(operationId)
        return next
    })
}

export function resetWikiGenerationState(): void {
    wikiGenerationOperations.set(new Set())
}
