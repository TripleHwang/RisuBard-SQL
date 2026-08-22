import { v4 as uuidv4 } from 'uuid'

export type OrganizableCollection = 'promptPresets' | 'modules' | 'plugins'

export interface CollectionFolder {
    id: string
    name: string
}

export interface CollectionOrganizerState {
    folders: CollectionFolder[]
    folderByItemId: Record<string, string>
    itemOrder: string[]
}

export type CollectionOrganizers = Partial<Record<OrganizableCollection, CollectionOrganizerState>>

type FolderFilter = string | null | undefined

function validItemIds(itemIds: readonly string[]): string[] {
    const seen = new Set<string>()
    const validIds: string[] = []
    for (const id of itemIds) {
        if (id && !seen.has(id)) {
            seen.add(id)
            validIds.push(id)
        }
    }
    return validIds
}

function cloneState(state: CollectionOrganizerState): CollectionOrganizerState {
    return {
        folders: state.folders.map((folder) => ({ ...folder })),
        folderByItemId: { ...state.folderByItemId },
        itemOrder: [...state.itemOrder],
    }
}

export function normalizeCollectionOrganizerState(
    saved: Partial<CollectionOrganizerState> | null | undefined,
    currentItemIds: readonly string[],
): CollectionOrganizerState {
    const folders: CollectionFolder[] = []
    const folderIds = new Set<string>()
    for (const folder of Array.isArray(saved?.folders) ? saved.folders : []) {
        const id = typeof folder?.id === 'string' ? folder.id.trim() : ''
        const name = typeof folder?.name === 'string' ? folder.name.trim() : ''
        if (!id || !name || folderIds.has(id)) continue
        folderIds.add(id)
        folders.push({ id, name })
    }

    const currentIds = validItemIds(currentItemIds)
    const currentIdSet = new Set(currentIds)
    const folderByItemId: Record<string, string> = {}
    if (saved?.folderByItemId && typeof saved.folderByItemId === 'object') {
        for (const [itemId, folderId] of Object.entries(saved.folderByItemId)) {
            if (currentIdSet.has(itemId) && typeof folderId === 'string' && folderIds.has(folderId)) {
                folderByItemId[itemId] = folderId
            }
        }
    }

    const ordered = new Set<string>()
    const itemOrder: string[] = []
    for (const itemId of Array.isArray(saved?.itemOrder) ? saved.itemOrder : []) {
        if (currentIdSet.has(itemId) && !ordered.has(itemId)) {
            ordered.add(itemId)
            itemOrder.push(itemId)
        }
    }
    for (const itemId of currentIds) {
        if (!ordered.has(itemId)) itemOrder.push(itemId)
    }

    return { folders, folderByItemId, itemOrder }
}

export function normalizeCollectionOrganizers(
    saved: CollectionOrganizers | null | undefined,
    itemIds: Record<OrganizableCollection, readonly string[]>,
): CollectionOrganizers {
    const organizers: CollectionOrganizers = {}
    for (const collection of Object.keys(itemIds) as OrganizableCollection[]) {
        const state = saved?.[collection]
        if (state) organizers[collection] = normalizeCollectionOrganizerState(state, itemIds[collection])
    }
    return organizers
}

export function assignCollectionItem(
    state: CollectionOrganizerState,
    itemId: string,
    folderId: string | null,
): CollectionOrganizerState {
    const next = cloneState(state)
    if (!next.itemOrder.includes(itemId)) return next
    if (folderId === null) {
        delete next.folderByItemId[itemId]
    } else if (next.folders.some((folder) => folder.id === folderId)) {
        next.folderByItemId[itemId] = folderId
    }
    return next
}

export function assignItemsToFolder(
    state: CollectionOrganizerState,
    itemIds: readonly string[],
    folderId: string | null,
): CollectionOrganizerState {
    return itemIds.reduce((next, itemId) => assignCollectionItem(next, itemId, folderId), state)
}

export function createCollectionFolder(
    state: CollectionOrganizerState,
    name: string,
    suppliedId?: string,
): CollectionOrganizerState {
    const id = (suppliedId ?? uuidv4()).trim()
    const trimmedName = name.trim()
    if (!id || !trimmedName || state.folders.some((folder) => folder.id === id)) return cloneState(state)
    return { ...cloneState(state), folders: [...state.folders, { id, name: trimmedName }] }
}

export function renameCollectionFolder(
    state: CollectionOrganizerState,
    folderId: string,
    name: string,
): CollectionOrganizerState {
    const trimmedName = name.trim()
    if (!trimmedName) return cloneState(state)
    return {
        ...cloneState(state),
        folders: state.folders.map((folder) => folder.id === folderId ? { ...folder, name: trimmedName } : { ...folder }),
    }
}

export function deleteCollectionFolder(state: CollectionOrganizerState, folderId: string): CollectionOrganizerState {
    const next = cloneState(state)
    next.folders = next.folders.filter((folder) => folder.id !== folderId)
    for (const [itemId, assignedFolderId] of Object.entries(next.folderByItemId)) {
        if (assignedFolderId === folderId) delete next.folderByItemId[itemId]
    }
    return next
}

export function filterCollectionItems(state: CollectionOrganizerState, folderId: FolderFilter): string[] {
    if (folderId === undefined) return [...state.itemOrder]
    return state.itemOrder.filter((itemId) => folderId === null
        ? state.folderByItemId[itemId] === undefined
        : state.folderByItemId[itemId] === folderId)
}

export function reorderVisibleCollectionItems(
    state: CollectionOrganizerState,
    visibleItemIds: readonly string[],
): CollectionOrganizerState {
    const knownIds = new Set(state.itemOrder)
    const replacementIds = validItemIds(visibleItemIds).filter((itemId) => knownIds.has(itemId))
    const visibleIds = new Set(replacementIds)
    let replacementIndex = 0
    const itemOrder = state.itemOrder.map((itemId) => visibleIds.has(itemId)
        ? replacementIds[replacementIndex++]!
        : itemId)
    return { ...cloneState(state), itemOrder }
}
