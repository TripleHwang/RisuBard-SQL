import type { loreBook } from 'src/ts/storage/database.svelte'

export type LoreBookActivationStatus = 'always' | 'keyword' | 'multiple-key' | 'unreachable'

export interface LoreBookVisualStatus {
    hidden: boolean
    unreachable: boolean
    activation: LoreBookActivationStatus
}

export function loreBookVisualStatus(entry: loreBook): LoreBookVisualStatus {
    const hidden = entry.enabled === false
    let activation: LoreBookActivationStatus

    if (entry.mode === 'folder' || entry.mode === 'child') activation = 'keyword'
    else if (entry.alwaysActive) activation = 'always'
    else if (!entry.key.trim()) activation = 'unreachable'
    else if (entry.selective) activation = 'multiple-key'
    else activation = 'keyword'

    return { hidden, unreachable: activation === 'unreachable', activation }
}
