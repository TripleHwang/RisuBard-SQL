import type { loreBook } from '../storage/database.svelte'

export type WikiLorebookConflictPolicy = 'overwrite' | 'suffix'

export interface WikiLorebookCopyResult {
    action: 'created' | 'overwritten'
    entry: loreBook
    lorebooks: loreBook[]
}

function nextSuffixedName(title: string, lorebooks: loreBook[]): string {
    const names = new Set(lorebooks.map((entry) => entry.comment.trim()))
    if (!names.has(title)) return title
    let suffix = 2
    while (names.has(`${title}-${suffix}`)) suffix += 1
    return `${title}-${suffix}`
}

function copiedEntry(input: {
    id: string
    title: string
    content: string
    folder?: string
    insertorder?: number
}): loreBook {
    return {
        id: input.id,
        enabled: false,
        key: '',
        secondkey: '',
        insertorder: input.insertorder ?? 100,
        comment: input.title,
        content: input.content,
        mode: 'normal',
        alwaysActive: false,
        selective: false,
        useRegex: false,
        bookVersion: 2,
        ...(input.folder ? { folder: input.folder } : {}),
    }
}

export function copyWikiDocumentToLorebook(
    lorebooks: loreBook[],
    document: { title: string; content: string },
    policy: WikiLorebookConflictPolicy,
    createId: () => string
): WikiLorebookCopyResult {
    const title = document.title.trim()
    if (!title) throw new Error('BardWiki document title is empty')
    const matchingIndex = lorebooks.findIndex((entry) =>
        entry.mode !== 'folder' && entry.comment.trim() === title
    )
    if (matchingIndex >= 0 && policy === 'overwrite') {
        const existing = lorebooks[matchingIndex]
        const entry = copiedEntry({
            id: existing.id || createId(),
            title,
            content: document.content,
            folder: existing.folder,
            insertorder: existing.insertorder,
        })
        const next = [...lorebooks]
        next[matchingIndex] = entry
        return { action: 'overwritten', entry, lorebooks: next }
    }
    const entry = copiedEntry({
        id: createId(),
        title: nextSuffixedName(title, lorebooks),
        content: document.content,
    })
    return {
        action: 'created',
        entry,
        lorebooks: [...lorebooks, entry],
    }
}
