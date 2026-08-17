import type { loreBook } from '../storage/database.svelte'

export function isLorebookEntryEnabled(entry: loreBook): boolean {
    return entry.enabled !== false
}

export function canRunLorebookSweep(completedSweeps: number, maxSteps: number): boolean {
    return maxSteps <= 0 || completedSweeps < maxSteps
}
