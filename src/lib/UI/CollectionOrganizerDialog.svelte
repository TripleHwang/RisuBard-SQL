<script lang="ts">
    import {
        ChevronDownIcon,
        ChevronUpIcon,
        FolderIcon,
        FolderPlusIcon,
        PencilIcon,
        TrashIcon,
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import { alertConfirm, alertInput } from 'src/ts/alert'
    import {
        assignItemsToFolder,
        createCollectionFolder,
        deleteCollectionFolder,
        getCollectionFolderCounts,
        getVisibleCollectionItems,
        normalizeCollectionOrganizerState,
        renameCollectionFolder,
        reorderVisibleCollectionItems,
        retainVisibleCollectionSelection,
        type CollectionKind,
        type CollectionOrganizerItem,
        type CollectionOrganizerState,
        type CollectionOrganizers,
    } from 'src/ts/collectionOrganizer'
    import { getDatabase } from 'src/ts/storage/database.svelte'
    import ShButton from './GUI/ShButton.svelte'
    import ShDialog from './GUI/ShDialog.svelte'
    import TextInput from './GUI/TextInput.svelte'

    interface Props {
        open?: boolean
        kind: CollectionKind
        items: CollectionOrganizerItem[]
        collectionLabel: string
        onOpenChange?: (open: boolean) => void
    }

    let {
        open = $bindable(false),
        kind,
        items,
        collectionLabel,
        onOpenChange,
    }: Props = $props()

    let selectedFolderId = $state<string | null | undefined>(undefined)
    let search = $state('')
    let newFolderName = $state('')
    let selectedItemIds = $state<string[]>([])
    let moveTarget = $state<string>('')
    let draggedItemIds = $state<string[]>([])
    let draggedFolderId = $state<string | null>(null)

    const itemIds = $derived(items.map((item) => item.id))
    const organizerState = $derived(normalizeCollectionOrganizerState(
        getDatabase().collectionOrganizers?.[kind],
        itemIds,
    ))
    const visibleItems = $derived(getVisibleCollectionItems(
        organizerState,
        items,
        selectedFolderId,
        search,
    ))
    const folderCounts = $derived(getCollectionFolderCounts(organizerState))
    const copy = $derived(language.collectionOrganizer)

    function emptyState(): CollectionOrganizerState {
        return { folders: [], folderByItemId: {}, itemOrder: [] }
    }

    function currentState(): CollectionOrganizerState {
        return normalizeCollectionOrganizerState(
            getDatabase().collectionOrganizers?.[kind],
            items.map((item) => item.id),
        )
    }

    function saveState(next: CollectionOrganizerState) {
        const db = getDatabase()
        const organizers: CollectionOrganizers = db.collectionOrganizers ?? {
            promptPresets: emptyState(),
            modules: emptyState(),
            plugins: emptyState(),
        }
        db.collectionOrganizers = {
            ...organizers,
            [kind]: normalizeCollectionOrganizerState(next, items.map((item) => item.id)),
        }
    }

    function handleOpenChange(next: boolean) {
        open = next
        if (!next) {
            selectedItemIds = []
            draggedItemIds = []
            draggedFolderId = null
        }
        onOpenChange?.(next)
    }

    function selectFolder(folderId: string | null | undefined) {
        selectedFolderId = folderId
        selectedItemIds = []
    }

    function createFolder() {
        if (!newFolderName.trim()) return
        saveState(createCollectionFolder(currentState(), newFolderName, crypto.randomUUID(), Date.now()))
        newFolderName = ''
    }

    async function renameFolder(folderId: string, currentName: string) {
        const nextName = await alertInput(copy.renameFolderPrompt, [], currentName)
        if (!nextName) return
        saveState(renameCollectionFolder(currentState(), folderId, nextName))
    }

    async function deleteFolder(folderId: string, folderName: string) {
        if (!await alertConfirm(copy.deleteFolderConfirm.replace('{}', folderName))) return
        saveState(deleteCollectionFolder(currentState(), folderId))
        if (selectedFolderId === folderId) selectFolder(null)
    }

    function reorderFolder(folderId: string, offset: number) {
        const state = currentState()
        const index = state.folders.findIndex((folder) => folder.id === folderId)
        const targetIndex = index + offset
        if (index < 0 || targetIndex < 0 || targetIndex >= state.folders.length) return
        const folders = [...state.folders]
        const [folder] = folders.splice(index, 1)
        folders.splice(targetIndex, 0, folder)
        saveState({ ...state, folders })
    }

    function dropFolder(targetFolderId: string) {
        if (!draggedFolderId || draggedFolderId === targetFolderId) return
        const state = currentState()
        const fromIndex = state.folders.findIndex((folder) => folder.id === draggedFolderId)
        const toIndex = state.folders.findIndex((folder) => folder.id === targetFolderId)
        if (fromIndex < 0 || toIndex < 0) return
        const folders = [...state.folders]
        const [folder] = folders.splice(fromIndex, 1)
        folders.splice(toIndex, 0, folder)
        saveState({ ...state, folders })
        draggedFolderId = null
    }

    function toggleSelection(itemId: string, checked: boolean) {
        selectedItemIds = checked
            ? Array.from(new Set([...selectedItemIds, itemId]))
            : selectedItemIds.filter((id) => id !== itemId)
    }

    function moveItems(itemIdsToMove: readonly string[], folderId: string | null) {
        const next = assignItemsToFolder(currentState(), itemIdsToMove, folderId)
        saveState(next)
        const nextVisibleIds = getVisibleCollectionItems(next, items, selectedFolderId, search)
            .map((item) => item.id)
        selectedItemIds = retainVisibleCollectionSelection(selectedItemIds, nextVisibleIds)
    }

    function bulkMove() {
        if (!selectedItemIds.length || !moveTarget) return
        moveItems(selectedItemIds, moveTarget === '__uncategorized__' ? null : moveTarget)
    }

    function moveVisibleItem(itemId: string, offset: number) {
        const visibleIds = visibleItems.map((item) => item.id)
        const index = visibleIds.indexOf(itemId)
        const targetIndex = index + offset
        if (index < 0 || targetIndex < 0 || targetIndex >= visibleIds.length) return
        const reordered = [...visibleIds]
        const [moved] = reordered.splice(index, 1)
        reordered.splice(targetIndex, 0, moved)
        saveState(reorderVisibleCollectionItems(currentState(), reordered))
    }

    function startItemDrag(event: DragEvent, itemId: string) {
        draggedItemIds = selectedItemIds.includes(itemId) ? [...selectedItemIds] : [itemId]
        if (!event.dataTransfer) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-risubard-collection-items', JSON.stringify(draggedItemIds))
    }

    function dropItemsOnFolder(event: DragEvent, folderId: string | null) {
        event.preventDefault()
        if (!draggedItemIds.length) return
        moveItems(draggedItemIds, folderId)
        draggedItemIds = []
    }

    function dropItemForReorder(event: DragEvent, targetItemId: string) {
        event.preventDefault()
        const sourceItemId = draggedItemIds[0]
        if (!sourceItemId || sourceItemId === targetItemId) return
        const visibleIds = visibleItems.map((item) => item.id)
        const fromIndex = visibleIds.indexOf(sourceItemId)
        const toIndex = visibleIds.indexOf(targetItemId)
        if (fromIndex < 0 || toIndex < 0) return
        const reordered = [...visibleIds]
        const [moved] = reordered.splice(fromIndex, 1)
        reordered.splice(toIndex, 0, moved)
        saveState(reorderVisibleCollectionItems(currentState(), reordered))
        draggedItemIds = []
    }
</script>

<ShDialog
    {open}
    onOpenChange={handleOpenChange}
    size="xl"
    tier="alert"
    closeOnEscape={true}
    contentClass="bg-darkbg"
    bodyClass="min-h-0"
    closeAriaLabel={copy.close}
>
    {#snippet title()}{copy.title.replace('{}', collectionLabel)}{/snippet}
    {#snippet description()}{copy.description}{/snippet}

    <div class="grid min-h-0 gap-3 md:grid-cols-[15rem_minmax(0,1fr)]">
        <aside class="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-md border border-darkborderc p-2 md:max-h-[60vh]">
            <button
                class="flex min-h-9 items-center justify-between rounded-md px-2 text-left hover:bg-selected/30 focus-visible:ring-2 focus-visible:ring-borderc/50"
                class:bg-selected={selectedFolderId === undefined}
                onclick={() => selectFolder(undefined)}
            >
                <span>{copy.all}</span><span class="text-xs text-textcolor2">{folderCounts.all}</span>
            </button>
            <button
                class="flex min-h-9 items-center justify-between rounded-md px-2 text-left hover:bg-selected/30 focus-visible:ring-2 focus-visible:ring-borderc/50"
                class:bg-selected={selectedFolderId === null}
                onclick={() => selectFolder(null)}
                ondragover={(event) => { if (draggedItemIds.length) event.preventDefault() }}
                ondrop={(event) => dropItemsOnFolder(event, null)}
            >
                <span>{copy.uncategorized}</span><span class="text-xs text-textcolor2">{folderCounts.uncategorized}</span>
            </button>

            <div class="my-1 border-t border-darkborderc"></div>
            <div class="flex flex-col gap-1" role="list" aria-label={copy.folders}>
                {#each organizerState.folders as folder, folderIndex (folder.id)}
                    <div
                        class="flex items-center rounded-md hover:bg-selected/30"
                        class:bg-selected={selectedFolderId === folder.id}
                        role="listitem"
                        draggable="true"
                        ondragstart={(event) => {
                            draggedFolderId = folder.id
                            event.dataTransfer?.setData('application/x-risubard-collection-folder', folder.id)
                        }}
                        ondragend={() => { draggedFolderId = null }}
                        ondragover={(event) => event.preventDefault()}
                        ondrop={(event) => {
                            event.preventDefault()
                            if (draggedFolderId) dropFolder(folder.id)
                            else dropItemsOnFolder(event, folder.id)
                        }}
                    >
                        <button class="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left" onclick={() => selectFolder(folder.id)}>
                            <FolderIcon size={15} />
                            <span class="min-w-0 flex-1 truncate">{folder.name}</span>
                            <span class="text-xs text-textcolor2">{folderCounts.byFolderId[folder.id] ?? 0}</span>
                        </button>
                        <div class="flex shrink-0 pr-1">
                            <ShButton variant="ghost" size="icon-xs" aria-label={copy.moveFolderUp} disabled={folderIndex === 0} onclick={() => reorderFolder(folder.id, -1)}><ChevronUpIcon /></ShButton>
                            <ShButton variant="ghost" size="icon-xs" aria-label={copy.moveFolderDown} disabled={folderIndex === organizerState.folders.length - 1} onclick={() => reorderFolder(folder.id, 1)}><ChevronDownIcon /></ShButton>
                            <ShButton variant="ghost" size="icon-xs" aria-label={copy.renameFolder} onclick={() => renameFolder(folder.id, folder.name)}><PencilIcon /></ShButton>
                            <ShButton variant="ghost" size="icon-xs" aria-label={copy.deleteFolder} onclick={() => deleteFolder(folder.id, folder.name)}><TrashIcon /></ShButton>
                        </div>
                    </div>
                {/each}
            </div>

            <div class="mt-auto flex gap-1 pt-1">
                <TextInput
                    size="sm"
                    className="min-w-0 grow"
                    bind:value={newFolderName}
                    placeholder={copy.newFolderPlaceholder}
                    onkeydown={(event) => { if (event.key === 'Enter') createFolder() }}
                />
                <ShButton variant="outline" size="icon-sm" aria-label={copy.createFolder} disabled={!newFolderName.trim()} onclick={createFolder}><FolderPlusIcon /></ShButton>
            </div>
        </aside>

        <section class="flex min-h-0 flex-col gap-2">
            <TextInput bind:value={search} placeholder={copy.searchPlaceholder} />

            <div class="flex flex-wrap items-center gap-2">
                <ShButton variant="outline" size="sm" onclick={() => {
                    selectedItemIds = Array.from(new Set([...selectedItemIds, ...visibleItems.map((item) => item.id)]))
                }}>{copy.selectVisible}</ShButton>
                <ShButton variant="ghost" size="sm" disabled={!selectedItemIds.length} onclick={() => { selectedItemIds = [] }}>{copy.clearSelection}</ShButton>
                <span class="text-xs text-textcolor2">{copy.selectedCount.replace('{}', String(selectedItemIds.length))}</span>
            </div>

            <div class="flex flex-col gap-2 rounded-md border border-darkborderc p-2 sm:flex-row">
                <select
                    class="min-h-9 min-w-0 grow rounded-md border border-darkborderc bg-darkbg px-2 text-textcolor focus:outline-none focus:ring-2 focus:ring-borderc/50"
                    bind:value={moveTarget}
                    aria-label={copy.moveTarget}
                >
                    <option value="">{copy.chooseFolder}</option>
                    <option value="__uncategorized__">{copy.uncategorized}</option>
                    {#each organizerState.folders as folder (folder.id)}
                        <option value={folder.id}>{folder.name}</option>
                    {/each}
                </select>
                <ShButton variant="default" size="sm" disabled={!selectedItemIds.length || !moveTarget} onclick={bulkMove}>{copy.moveSelected}</ShButton>
            </div>

            <div class="flex max-h-[44vh] min-h-40 flex-col gap-1 overflow-y-auto rounded-md border border-darkborderc p-2" role="list" aria-label={copy.items}>
                {#if visibleItems.length === 0}
                    <p class="m-auto text-sm text-textcolor2">{copy.noItems}</p>
                {:else}
                    {#each visibleItems as item, itemIndex (item.id)}
                        <div
                            class="flex items-center gap-2 rounded-md border border-darkborderc p-2 hover:bg-selected/20"
                            role="listitem"
                            draggable="true"
                            ondragstart={(event) => startItemDrag(event, item.id)}
                            ondragend={() => { draggedItemIds = [] }}
                            ondragover={(event) => { if (draggedItemIds.length) event.preventDefault() }}
                            ondrop={(event) => dropItemForReorder(event, item.id)}
                        >
                            <input
                                type="checkbox"
                                class="size-4 accent-primary"
                                aria-label={copy.selectItem.replace('{}', item.title)}
                                checked={selectedItemIds.includes(item.id)}
                                onchange={(event) => toggleSelection(item.id, event.currentTarget.checked)}
                            />
                            <div class="min-w-0 flex-1">
                                <div class="truncate font-medium">{item.title}</div>
                                {#if item.detail}<div class="truncate text-xs text-textcolor2">{item.detail}</div>{/if}
                            </div>
                            <ShButton variant="ghost" size="icon-sm" aria-label={copy.moveItemUp} disabled={itemIndex === 0} onclick={() => moveVisibleItem(item.id, -1)}><ChevronUpIcon /></ShButton>
                            <ShButton variant="ghost" size="icon-sm" aria-label={copy.moveItemDown} disabled={itemIndex === visibleItems.length - 1} onclick={() => moveVisibleItem(item.id, 1)}><ChevronDownIcon /></ShButton>
                        </div>
                    {/each}
                {/if}
            </div>
        </section>
    </div>
</ShDialog>
