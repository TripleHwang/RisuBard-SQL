import type { loreBook } from 'src/ts/storage/database.svelte'

export type StableLorebookOwner = { id?: string }
export type GlobalLorebookPage = StableLorebookOwner & {
    name: string
    data: loreBook[]
}

export function ensureStableLorebookOwnerId(
    owner: StableLorebookOwner,
    createId: () => string,
): string {
    owner.id ||= createId()
    return owner.id
}

export function ensureGlobalLorebookPageIds(
    pages: GlobalLorebookPage[],
    createId: () => string,
): void {
    for (const page of pages) ensureStableLorebookOwnerId(page, createId)
}
