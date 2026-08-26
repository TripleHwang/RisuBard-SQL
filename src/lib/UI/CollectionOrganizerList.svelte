<script lang="ts">
    import type { Snippet } from 'svelte'
    import {
        ChevronDownIcon,
        ChevronUpIcon,
        FolderIcon,
        FolderPlusIcon,
        GripVerticalIcon,
        PencilIcon,
        TrashIcon,
    } from '@lucide/svelte'
    import { v4 as uuidv4 } from 'uuid'
    import { language } from 'src/lang'
    import { alertConfirm, alertInput } from 'src/ts/alert'
    import { requestImmediateSave } from 'src/ts/globalApi.svelte'
    import {
        assignItemsToFolder,
        createCollectionFolder,
        deleteCollectionFolder,
        getCollectionFolderCounts,
        getCollectionItemDragState,
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
    import TextInput from './GUI/TextInput.svelte'
    import { resizeHandle } from 'src/ts/gui/resizeHandle'

    interface Props {
        kind: CollectionKind
        items: CollectionOrganizerItem[]
        collectionLabel: string
        selectedFolderId?: string | null
        itemContent: Snippet<[string]>
        toolbar?: Snippet<[string | null | undefined]>
    }

    let {
        kind,
        items,
        collectionLabel,
        selectedFolderId = $bindable(undefined),
        itemContent,
        toolbar,
    }: Props = $props()

    let search = $state('')
    let newFolderName = $state('')
    let selectedItemIds = $state<string[]>([])
    let moveTarget = $state<string>('')
    let draggedItemIds = $state<string[]>([])
    let primaryDraggedItemId = $state<string | null>(null)
    let draggedFolderId = $state<string | null>(null)
    let organizerElement: HTMLElement | null = $state(null)
    let sidebarWidth = $state<number | null>(null)

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

    $effect(() => {
        const retainedSelection = selectedItemIds.filter((id) => itemIds.includes(id))
        if (retainedSelection.length !== selectedItemIds.length) selectedItemIds = retainedSelection

        const folderIds = organizerState.folders.map((folder) => folder.id)
        if (typeof selectedFolderId === 'string' && !folderIds.includes(selectedFolderId)) selectedFolderId = undefined
        if (moveTarget && moveTarget !== '__uncategorized__' && !folderIds.includes(moveTarget)) moveTarget = ''
    })

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
        void requestImmediateSave()
    }

    function selectFolder(folderId: string | null | undefined) {
        selectedFolderId = folderId
        selectedItemIds = []
        moveTarget = ''
    }

    function createFolder() {
        if (!newFolderName.trim()) return
        const id = uuidv4()
        saveState(createCollectionFolder(currentState(), newFolderName, id, Date.now()))
        newFolderName = ''
        selectFolder(id)
    }

    async function renameFolder(folderId: string, currentName: string) {
        const nextName = await alertInput(copy.renameFolderPrompt, [], currentName)
        if (!nextName) return
        saveState(renameCollectionFolder(currentState(), folderId, nextName))
    }

    async function deleteFolder(folderId: string, folderName: string) {
        if (!await alertConfirm(copy.deleteFolderConfirm.replace('{}', folderName))) return
        saveState(deleteCollectionFolder(currentState(), folderId))
        if (selectedFolderId === folderId) selectFolder(undefined)
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
        const dragState = getCollectionItemDragState(itemId, selectedItemIds)
        primaryDraggedItemId = dragState.primaryItemId
        draggedItemIds = dragState.itemIds
        if (!event.dataTransfer) return
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('application/x-risubard-collection-items', JSON.stringify(draggedItemIds))
    }

    function dropItemsOnFolder(event: DragEvent, folderId: string | null) {
        event.preventDefault()
        if (!draggedItemIds.length) return
        moveItems(draggedItemIds, folderId)
        draggedItemIds = []
        primaryDraggedItemId = null
    }

    function dropItemForReorder(event: DragEvent, targetItemId: string) {
        event.preventDefault()
        const sourceItemId = primaryDraggedItemId
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
        primaryDraggedItemId = null
    }

    function startPaneResize() {
        const element = organizerElement
        if (!element) return
        const { width } = element.getBoundingClientRect()
        const initial = sidebarWidth ?? Math.min(208, width * 0.45)
        const maximum = Math.max(176, Math.min(420, width * 0.55))
        return (dx: number) => {
            sidebarWidth = Math.min(maximum, Math.max(176, initial + dx))
        }
    }

    function resetPaneResize() {
        sidebarWidth = null
    }
</script>

<div
    bind:this={organizerElement}
    class="collection-organizer grid min-h-72 overflow-hidden rounded-md border border-darkborderc md:grid-cols-[var(--collection-sidebar-width,13rem)_minmax(0,1fr)]"
    style:--collection-sidebar-width={sidebarWidth === null ? undefined : `${sidebarWidth}px`}
    data-collection-organizer-list={kind}
>
    <aside class="flex max-h-60 min-h-0 flex-col border-b border-darkborderc p-2 md:max-h-none md:border-b-0 md:border-r">
        <div class="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-textcolor2">{collectionLabel}</div>
        <div class="min-h-0 grow overflow-y-auto">
            <button
                class="flex min-h-9 w-full items-center justify-between rounded-md px-2 text-left hover:bg-selected/30 focus-visible:ring-2 focus-visible:ring-borderc/50"
                class:bg-selected={selectedFolderId === undefined}
                onclick={() => selectFolder(undefined)}
            >
                <span>{copy.all}</span><span class="text-xs text-textcolor2">{folderCounts.all}</span>
            </button>
            <button
                class="flex min-h-9 w-full items-center justify-between rounded-md px-2 text-left hover:bg-selected/30 focus-visible:ring-2 focus-visible:ring-borderc/50"
                class:bg-selected={selectedFolderId === null}
                onclick={() => selectFolder(null)}
                ondragover={(event) => { if (draggedItemIds.length) event.preventDefault() }}
                ondrop={(event) => dropItemsOnFolder(event, null)}
            >
                <span>{copy.uncategorized}</span><span class="text-xs text-textcolor2">{folderCounts.uncategorized}</span>
            </button>

            <div class="my-2 border-t border-darkborderc"></div>
            <div class="flex flex-col gap-1" role="list" aria-label={copy.folders}>
                {#each organizerState.folders as folder, folderIndex (folder.id)}
                    <div
                        class="group flex min-h-10 items-center rounded-md hover:bg-selected/30"
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
                            <span class="text-xs text-textcolor2 group-hover:hidden">{folderCounts.byFolderId[folder.id] ?? 0}</span>
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
        </div>

        <div class="mt-2 flex gap-1 border-t border-darkborderc pt-2">
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

    <button
        type="button"
        class="collection-organizer__pane-resizer"
        data-collection-pane-resizer
        aria-label={copy.resizePanes}
        title={copy.resizeHint}
        use:resizeHandle={{ start: startPaneResize, reset: resetPaneResize }}
    ><span></span></button>

    <section class="flex min-h-0 min-w-0 flex-col gap-2 p-3">
        <div class="flex flex-col gap-2 sm:flex-row">
            <TextInput className="min-w-0 grow" bind:value={search} placeholder={copy.searchPlaceholder} />
            {#if toolbar}{@render toolbar(selectedFolderId)}{/if}
        </div>

        <div class="flex flex-wrap items-center gap-2 rounded-md bg-selected/10 px-2 py-1.5">
            <ShButton variant="ghost" size="sm" onclick={() => {
                selectedItemIds = Array.from(new Set([...selectedItemIds, ...visibleItems.map((item) => item.id)]))
            }}>{copy.selectVisible}</ShButton>
            <ShButton variant="ghost" size="sm" disabled={!selectedItemIds.length} onclick={() => { selectedItemIds = [] }}>{copy.clearSelection}</ShButton>
            <span class="text-xs text-textcolor2">{copy.selectedCount.replace('{}', String(selectedItemIds.length))}</span>
            <div class="min-w-8 grow"></div>
            <select
                class="min-h-8 min-w-36 rounded-md border border-darkborderc bg-darkbg px-2 text-sm text-textcolor focus:outline-none focus:ring-2 focus:ring-borderc/50"
                bind:value={moveTarget}
                aria-label={copy.moveTarget}
            >
                <option value="">{copy.chooseFolder}</option>
                <option value="__uncategorized__">{copy.uncategorized}</option>
                {#each organizerState.folders as folder (folder.id)}
                    <option value={folder.id}>{folder.name}</option>
                {/each}
            </select>
            <ShButton variant="outline" size="sm" disabled={!selectedItemIds.length || !moveTarget} onclick={bulkMove}>{copy.moveSelected}</ShButton>
        </div>

        <div class="flex min-h-40 flex-col divide-y divide-darkborderc overflow-y-auto rounded-md border border-darkborderc" role="list" aria-label={copy.items}>
            {#if visibleItems.length === 0}
                <p class="m-auto p-6 text-sm text-textcolor2">{copy.noItems}</p>
            {:else}
                {#each visibleItems as item, itemIndex (item.id)}
                    <div
                        class="flex min-w-0 items-start gap-2 p-2 hover:bg-selected/20"
                        role="listitem"
                        ondragover={(event) => { if (draggedItemIds.length) event.preventDefault() }}
                        ondrop={(event) => dropItemForReorder(event, item.id)}
                    >
                        <input
                            type="checkbox"
                            class="mt-2 size-4 shrink-0 accent-primary"
                            aria-label={copy.selectItem.replace('{}', item.title)}
                            checked={selectedItemIds.includes(item.id)}
                            onchange={(event) => toggleSelection(item.id, event.currentTarget.checked)}
                        />
                        <button
                            type="button"
                            class="mt-0.5 flex size-7 shrink-0 cursor-grab items-center justify-center rounded text-textcolor2 hover:bg-selected/40 hover:text-textcolor active:cursor-grabbing"
                            draggable="true"
                            data-collection-drag-handle
                            aria-label={copy.dragItem}
                            onclick={(event) => event.stopPropagation()}
                            ondragstart={(event) => startItemDrag(event, item.id)}
                            ondragend={() => {
                                draggedItemIds = []
                                primaryDraggedItemId = null
                            }}
                        ><GripVerticalIcon size={16} /></button>
                        <div class="min-w-0 grow">{@render itemContent(item.id)}</div>
                        <div class="flex shrink-0 pt-1">
                            <ShButton variant="ghost" size="icon-sm" aria-label={copy.moveItemUp} disabled={itemIndex === 0} onclick={() => moveVisibleItem(item.id, -1)}><ChevronUpIcon /></ShButton>
                            <ShButton variant="ghost" size="icon-sm" aria-label={copy.moveItemDown} disabled={itemIndex === visibleItems.length - 1} onclick={() => moveVisibleItem(item.id, 1)}><ChevronDownIcon /></ShButton>
                        </div>
                    </div>
                {/each}
            {/if}
        </div>
    </section>
</div>

<style>
    .collection-organizer { position: relative; }
    .collection-organizer__pane-resizer {
        position: absolute;
        z-index: 5;
        top: 0;
        bottom: 0;
        left: calc(var(--collection-sidebar-width, 13rem) - .3rem);
        width: .6rem;
        border: 0;
        padding: 0;
        background: transparent;
        cursor: col-resize;
        touch-action: none;
    }
    .collection-organizer__pane-resizer::before {
        position: absolute;
        top: 50%;
        left: .2rem;
        width: .2rem;
        height: 3rem;
        border-radius: 999px;
        background: var(--color-darkborderc);
        content: '';
        transition: background 120ms ease, height 120ms ease;
    }
    .collection-organizer__pane-resizer:hover::before,
    .collection-organizer__pane-resizer:focus-visible::before,
    .collection-organizer__pane-resizer:global([data-resizing])::before {
        height: 4rem;
        background: var(--color-borderc);
    }
    .collection-organizer__pane-resizer:focus-visible { outline: 2px solid color-mix(in srgb, var(--color-borderc) 70%, transparent); outline-offset: -2px; }
    @media (max-width: 767px) { .collection-organizer__pane-resizer { display: none; } }
</style>
