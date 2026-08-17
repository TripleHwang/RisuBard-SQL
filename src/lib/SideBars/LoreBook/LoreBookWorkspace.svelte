<script lang="ts">
    import { onDestroy, onMount, tick } from 'svelte'
    import Sortable from 'sortablejs'
    import { v4 as createUuid } from 'uuid'
    import { language } from 'src/lang'
    import type { loreBook } from 'src/ts/storage/database.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import {
        addLorebookEntry,
        addKeysToEntries,
        applyBatchPatch,
        deleteLorebookEntries,
        ensureLorebookIds,
        filterLorebookEntries,
        moveLorebookEntries,
        removeKeysFromEntries,
        updateLorebookEntry,
        type LorebookDropPosition,
    } from 'src/ts/lorebook/workspaceOperations'
    import { migrateLoremasterDisabledEntries } from 'src/ts/lorebook/loremasterMigration'
    import { alertConfirm, notifySuccess } from 'src/ts/alert'
    import type { LorebookLocalActivation } from './loreBookWorkspaceConnections'
    import SolarIcon from './SolarIcon.svelte'
    import {
        readLorebookWorkspaceSession,
        writeLorebookWorkspaceSession,
        type LorebookWorkspaceSession,
    } from './loreBookWorkspaceSession'
    import squareAltArrowDownIcon from 'src/assets/solar-bold/square-alt-arrow-down-bold.svg'
    import squareAltArrowRightIcon from 'src/assets/solar-bold/square-alt-arrow-right-bold.svg'
    import documentAddIcon from 'src/assets/solar-bold/document-add-bold.svg'
    import addFolderIcon from 'src/assets/solar-bold/add-folder-bold.svg'
    import fileDownloadIcon from 'src/assets/solar-bold/file-download-bold.svg'
    import fileSendIcon from 'src/assets/solar-bold/file-send-bold.svg'
    import altArrowUpIcon from 'src/assets/solar-bold/alt-arrow-up-bold.svg'
    import altArrowDownIcon from 'src/assets/solar-bold/alt-arrow-down-bold.svg'
    import altArrowLeftIcon from 'src/assets/solar-bold/alt-arrow-left-bold.svg'
    import moveToFolderIcon from 'src/assets/solar-bold/move-to-folder-bold.svg'
    import trashIcon from 'src/assets/solar-bold/trash-bin-2-bold.svg'
    import dragIcon from 'src/assets/solar-bold/hamburger-menu-bold.svg'
    import clearIcon from 'src/assets/solar-bold/close-circle-bold.svg'
    import folderOpenIcon from 'src/assets/solar-bold/folder-open-bold.svg'
    import folderIcon from 'src/assets/solar-bold/folder-bold.svg'
    import editIcon from 'src/assets/solar-bold/pen-2-bold.svg'

    interface Props {
        entries: loreBook[]
        scopeLabel: string
        scopeKey?: string
        active?: boolean
        dragEnabled?: boolean
        legacyDisabledBackups?: Record<string, loreBook & { disabled?: boolean }>
        localActivation?: LorebookLocalActivation
        onChange: (entries: loreBook[]) => void
        onImport?: () => void | Promise<void>
        onExport?: () => void | Promise<void>
        resolveChildLabel?: (id: string) => string | undefined
    }

    let {
        entries,
        scopeLabel,
        scopeKey,
        active = true,
        dragEnabled = true,
        legacyDisabledBackups,
        localActivation,
        onChange,
        onImport,
        onExport,
        resolveChildLabel,
    }: Props = $props()

    let selectedIds = $state(new Set<string>())
    let activeId = $state<string | null>(null)
    let selectionAnchorId = $state<string | null>(null)
    let expandedFolderIds = $state(new Set<string>())
    let query = $state('')
    let searchTarget = $state<'name' | 'keys'>('name')
    let enabledFilter = $state<'all' | 'enabled' | 'disabled'>('all')
    let mobileView = $state<'list' | 'editor'>('list')
    let batchKeys = $state('')
    let targetFolderId = $state('')
    let draftEntryId = $state<string | null>(null)
    type DraftField = 'comment' | 'key' | 'secondkey' | 'content' | 'insertorder'
    let drafts = $state<Record<DraftField, string>>({ comment: '', key: '', secondkey: '', content: '', insertorder: '100' })
    let dirtyDraftFields = $state(new Set<DraftField>())
    let listElement: HTMLElement | undefined = $state()
    let editorElement: HTMLElement | undefined = $state()
    let workspaceElement: HTMLElement | undefined = $state()
    let sortable: Sortable | undefined
    let dropIntent: { targetId: string; position: LorebookDropPosition } | null = null
    let dragOrigin: { item: HTMLElement; parent: Node; nextSibling: ChildNode | null } | null = null
    let mobileViewport = $state(false)
    let stateScopeOwner: {
        key: string
        sessionKey?: string
        onChange: (entries: loreBook[]) => void
    } | null = null
    let previousActive: boolean | null = null
    let destroyed = false
    type FocusSnapshot = Pick<LorebookWorkspaceSession, 'focusTarget' | 'focusSelectionStart' | 'focusSelectionEnd' | 'focusedScrollTop'>
    let lastFocus: FocusSnapshot = {
        focusTarget: null,
        focusSelectionStart: null,
        focusSelectionEnd: null,
        focusedScrollTop: 0,
    }

    let normalizedSource: loreBook[] | null = null
    let normalizedEntries = $state.raw<loreBook[]>([])
    const persistedIdSources = new WeakSet<loreBook[]>()
    let visibleEntries = $derived(filterLorebookEntries(normalizedEntries, {
        query,
        target: searchTarget,
        enabled: enabledFilter,
    }))
    let activeEntry = $derived(normalizedEntries.find((item) => item.id === activeId) ?? null)
    let folders = $derived(normalizedEntries.filter((item) => item.mode === 'folder'))
    let folderByKey = $derived.by(() => new Map(folders.map((folder) => [folder.key, folder])))
    let folderChildCounts = $derived.by(() => {
        const counts = new Map<string, number>()
        for (const item of normalizedEntries) {
            if (item.folder) counts.set(item.folder, (counts.get(item.folder) ?? 0) + 1)
        }
        return counts
    })
    let restorableCount = $derived.by(() => {
        if (!legacyDisabledBackups) return 0
        return migrateLoremasterDisabledEntries(
            normalizedEntries as Array<loreBook & { disabled?: boolean }>,
            legacyDisabledBackups,
        ).restoredIds.length
    })

    const isBatchEditable = (entry: loreBook) => entry.mode !== 'folder' && entry.mode !== 'child'

    function sameIds(left: Set<string>, right: Set<string>): boolean {
        return left.size === right.size && [...left].every((id) => right.has(id))
    }

    function focusSnapshot(focused: HTMLElement): FocusSnapshot {
        const field = focused.dataset.lorebookField
        const row = focused.closest<HTMLElement>('[data-lorebook-row]')
        const focusTarget = field
            ? `field:${field}`
            : focused.hasAttribute('data-lorebook-folder-name')
                ? 'folder-name'
                : focused.hasAttribute('data-lorebook-search')
                    ? 'search'
                    : row?.dataset.lorebookRow ? `row:${row.dataset.lorebookRow}` : null
        const textControl = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
        return {
            focusTarget,
            focusSelectionStart: textControl ? focused.selectionStart : null,
            focusSelectionEnd: textControl ? focused.selectionEnd : null,
            focusedScrollTop: focused.scrollTop,
        }
    }

    function rememberFocus(target: EventTarget | null): void {
        if (target instanceof HTMLElement && workspaceElement?.contains(target)) lastFocus = focusSnapshot(target)
    }

    function currentFocusTarget(): FocusSnapshot {
        const focused = document.activeElement instanceof HTMLElement && workspaceElement?.contains(document.activeElement)
            ? document.activeElement
            : null
        return focused ? focusSnapshot(focused) : lastFocus
    }

    function saveWorkspaceSession(key: string): void {
        const focus = currentFocusTarget()
        writeLorebookWorkspaceSession(key, {
            activeId,
            selectedIds: [...selectedIds],
            selectionAnchorId,
            expandedFolderIds: [...expandedFolderIds],
            listScrollTop: listElement?.scrollTop ?? 0,
            editorScrollTop: editorElement?.scrollTop ?? 0,
            ...focus,
        })
    }

    async function restoreWorkspacePosition(key: string, session: LorebookWorkspaceSession): Promise<void> {
        await tick()
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
        if (destroyed || stateScopeOwner?.key !== key) return
        if (listElement) listElement.scrollTop = session.listScrollTop
        if (editorElement) editorElement.scrollTop = session.editorScrollTop
        const target = session.focusTarget?.startsWith('field:')
            ? workspaceElement?.querySelector<HTMLElement>(`[data-lorebook-field="${session.focusTarget.slice(6)}"]`)
            : session.focusTarget === 'folder-name'
                ? workspaceElement?.querySelector<HTMLElement>('[data-lorebook-folder-name]')
                : session.focusTarget === 'search'
                    ? workspaceElement?.querySelector<HTMLElement>('[data-lorebook-search]')
                    : session.focusTarget?.startsWith('row:')
                        ? [...(workspaceElement?.querySelectorAll<HTMLElement>('[data-lorebook-row]') ?? [])]
                            .find((row) => row.dataset.lorebookRow === session.focusTarget?.slice(4))
                            ?.querySelector<HTMLElement>('.row-main')
                        : null
        target?.focus({ preventScroll: true })
        if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)
            && session.focusSelectionStart !== null && session.focusSelectionEnd !== null) {
            target.setSelectionRange(session.focusSelectionStart, session.focusSelectionEnd)
            target.scrollTop = session.focusedScrollTop
        }
    }

    $effect(() => {
        const source = entries
        const currentScopeKey = scopeKey ?? scopeLabel
        const scopeChanged = stateScopeOwner !== null && stateScopeOwner.key !== currentScopeKey
        const hydrateScope = stateScopeOwner === null || scopeChanged
        if (scopeChanged && stateScopeOwner) {
            if (stateScopeOwner.sessionKey) saveWorkspaceSession(stateScopeOwner.sessionKey)
            commitDirtyToOwner(stateScopeOwner.onChange)
        }
        stateScopeOwner = { key: currentScopeKey, sessionKey: scopeKey, onChange }
        if (source !== normalizedSource) {
            normalizedSource = source
            normalizedEntries = ensureLorebookIds(source, createUuid)
        }

        if (hydrateScope) {
            const session = scopeKey ? readLorebookWorkspaceSession(scopeKey) : undefined
            selectedIds = new Set(session?.selectedIds ?? [])
            activeId = session?.activeId ?? null
            selectionAnchorId = session?.selectionAnchorId ?? null
            expandedFolderIds = new Set(session?.expandedFolderIds ?? [])
            targetFolderId = ''
            mobileView = activeId ? 'editor' : 'list'
            if (session) {
                lastFocus = session
                void restoreWorkspacePosition(currentScopeKey, session)
            }
        }

        const entriesById = new Map(normalizedEntries.filter((entry) => entry.id).map((entry) => [entry.id!, entry]))
        const nextSelected = new Set([...selectedIds].filter((id) => {
            const entry = entriesById.get(id)
            return entry ? isBatchEditable(entry) : false
        }))
        if (!sameIds(selectedIds, nextSelected)) selectedIds = nextSelected
        const anchorEntry = selectionAnchorId ? entriesById.get(selectionAnchorId) : undefined
        if (selectionAnchorId && (!anchorEntry || !isBatchEditable(anchorEntry))) {
            selectionAnchorId = null
        }
        if (activeId && !entriesById.has(activeId)) {
            activeId = null
            mobileView = 'list'
        }
        const nextExpanded = new Set([...expandedFolderIds].filter((id) => entriesById.get(id)?.mode === 'folder'))
        if (!sameIds(expandedFolderIds, nextExpanded)) expandedFolderIds = nextExpanded
        if (targetFolderId && entriesById.get(targetFolderId)?.mode !== 'folder') targetFolderId = ''

        if (!persistedIdSources.has(source)) {
            persistedIdSources.add(source)
            if (normalizedEntries.some((entry, index) => entry !== source[index])) {
                onChange(normalizedEntries)
            }
        }
    })

    $effect(() => {
        const currentActive = active
        if (previousActive === true && !currentActive && stateScopeOwner) {
            if (stateScopeOwner.sessionKey) saveWorkspaceSession(stateScopeOwner.sessionKey)
            commitDirtyToOwner(stateScopeOwner.onChange)
        }
        if (previousActive === false && currentActive && stateScopeOwner) {
            const session = stateScopeOwner.sessionKey
                ? readLorebookWorkspaceSession(stateScopeOwner.sessionKey)
                : undefined
            if (session) void restoreWorkspacePosition(stateScopeOwner.key, session)
        }
        previousActive = currentActive
    })

    $effect(() => {
        if (!activeEntry) {
            draftEntryId = null
            dirtyDraftFields = new Set()
            return
        }
        const values: Record<DraftField, string> = {
            comment: activeEntry.comment,
            key: activeEntry.key,
            secondkey: activeEntry.secondkey,
            content: activeEntry.content,
            insertorder: String(activeEntry.insertorder),
        }
        if (activeEntry.id !== draftEntryId) {
            draftEntryId = activeEntry.id ?? null
            dirtyDraftFields = new Set()
            drafts = values
            return
        }
        const next = { ...drafts }
        let changed = false
        for (const field of Object.keys(values) as DraftField[]) {
            if (!dirtyDraftFields.has(field) && next[field] !== values[field]) {
                next[field] = values[field]
                changed = true
            }
        }
        if (changed) drafts = next
    })

    function emit(next: loreBook[]) {
        if (next === normalizedEntries) return
        normalizedEntries = next
        onChange(next)
    }

    function markDraftDirty(field: DraftField, value: string) {
        drafts[field] = value
        const next = new Set(dirtyDraftFields)
        next.add(field)
        dirtyDraftFields = next
    }

    function draftPatch(fields: Iterable<DraftField>): Partial<loreBook> {
        const patch: Partial<loreBook> = {}
        for (const field of fields) {
            if (field === 'insertorder') patch.insertorder = Number.parseInt(drafts.insertorder, 10) || 0
            else patch[field] = drafts[field]
        }
        return patch
    }

    function applyEntryPatch(base: loreBook[], id: string, patch: Partial<loreBook>): loreBook[] {
        const entry = base.find((item) => item.id === id)
        return entry?.mode === 'folder'
            ? updateLorebookEntry(base, id, patch)
            : applyBatchPatch(base, new Set([id]), patch)
    }

    function commitAllDirty(base = normalizedEntries): loreBook[] {
        if (!activeEntry?.id || dirtyDraftFields.size === 0 || activeEntry.mode === 'child') return base
        const patch = draftPatch(dirtyDraftFields)
        dirtyDraftFields = new Set()
        return applyEntryPatch(base, activeEntry.id, patch)
    }

    function commitDirtyToOwner(callback: (entries: loreBook[]) => void): void {
        if (!activeId || dirtyDraftFields.size === 0) return
        const target = normalizedEntries.find((entry) => entry.id === activeId)
        if (!target || target.mode === 'child') return
        const next = applyEntryPatch(normalizedEntries, activeId, draftPatch(dirtyDraftFields))
        dirtyDraftFields = new Set()
        normalizedEntries = next
        callback(next)
    }

    onDestroy(() => {
        destroyed = true
        if (stateScopeOwner) {
            if (stateScopeOwner.sessionKey) saveWorkspaceSession(stateScopeOwner.sessionKey)
            commitDirtyToOwner(stateScopeOwner.onChange)
        }
    })

    function patchEntry(id: string, patch: Partial<loreBook>) {
        const base = commitAllDirty()
        emit(applyEntryPatch(base, id, patch))
    }

    function commitDraft(field: DraftField) {
        if (!activeEntry?.id || !dirtyDraftFields.has(field) || activeEntry.mode === 'child') return
        const nextDirty = new Set(dirtyDraftFields)
        nextDirty.delete(field)
        dirtyDraftFields = nextDirty
        emit(applyEntryPatch(normalizedEntries, activeEntry.id, draftPatch([field])))
    }

    function commitOnShortcut(event: KeyboardEvent, field: keyof typeof drafts) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault()
            commitDraft(field)
        }
    }

    function setSelected(next: Set<string>) {
        selectedIds = next
    }

    function toggleSelection(id: string) {
        const next = new Set(selectedIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        selectionAnchorId = id
        setSelected(next)
    }

    function selectEntry(id: string, event: MouseEvent | undefined, toggleWithoutModifier = false) {
        const selectable = visibleEntries.filter((item) => item.mode !== 'folder' && item.mode !== 'child' && item.id)
        const eligible = selectable.some((item) => item.id === id)
        if (!eligible) return
        if (event?.shiftKey && !selectionAnchorId) return
        if (event?.shiftKey && selectionAnchorId) {
            const start = selectable.findIndex((item) => item.id === selectionAnchorId)
            const end = selectable.findIndex((item) => item.id === id)
            if (start >= 0 && end >= 0) {
                const next = event.ctrlKey || event.metaKey ? new Set(selectedIds) : new Set<string>()
                for (const item of selectable.slice(Math.min(start, end), Math.max(start, end) + 1)) {
                    next.add(item.id!)
                }
                setSelected(next)
            }
        }
        else if (event?.ctrlKey || event?.metaKey || toggleWithoutModifier) {
            toggleSelection(id)
        }
        else {
            selectedIds = new Set([id])
            selectionAnchorId = id
        }
    }

    function openEntry(id: string, event?: MouseEvent) {
        const entry = normalizedEntries.find((item) => item.id === id)
        if (entry && isBatchEditable(entry)
            && (selectedIds.size === 0 || event?.shiftKey || event?.ctrlKey || event?.metaKey)) {
            selectEntry(id, event)
        }
        activeId = id
        mobileView = 'editor'
    }

    function selectFromCheckbox(id: string, event: MouseEvent) {
        event.preventDefault()
        selectEntry(id, event, true)
    }

    function clearSelection() {
        selectedIds = new Set()
        selectionAnchorId = null
    }

    function batchPatch(patch: Partial<loreBook>) {
        const base = commitAllDirty()
        emit(applyBatchPatch(base, selectedIds, patch))
    }

    function batchKeysChange(field: 'key' | 'secondkey', remove: boolean) {
        const keys = batchKeys.split(',')
        const base = commitAllDirty()
        const next = remove
            ? removeKeysFromEntries(base, selectedIds, field, keys)
            : addKeysToEntries(base, selectedIds, field, keys)
        emit(next)
    }

    function addEntry(mode: loreBook['mode'] = 'normal') {
        const base = commitAllDirty()
        const id = createUuid()
        const folderKey = `\uf000folder:${id}`
        const next: loreBook = {
            id,
            key: mode === 'folder' ? folderKey : '',
            secondkey: '',
            insertorder: (base.length + 1) * 10,
            comment: mode === 'folder'
                ? language.lorebookWorkspace.newFolder
                : language.lorebookWorkspace.newLore,
            content: '',
            mode,
            alwaysActive: false,
            selective: false,
        }
        emit(addLorebookEntry(base, next))
        activeId = id
        mobileView = 'editor'
    }

    async function removeActive() {
        if (!activeEntry) return
        const target = activeEntry
        const sourceEntries = normalizedEntries
        const targetScopeOwner = stateScopeOwner
        const targetOnChange = targetScopeOwner?.onChange ?? onChange
        const targetLocalActivation = localActivation
        const childCount = target.mode === 'folder'
            ? sourceEntries.filter((item) => item.folder === target.key).length
            : 0
        const message = target.mode === 'folder'
            ? language.lorebookWorkspace.deleteFolderConfirm(
                target.comment || language.lorebookWorkspace.untitledFolder,
                childCount,
            )
            : language.lorebookWorkspace.deleteEntryConfirm(
                target.comment || language.lorebookWorkspace.untitledLore,
            )
        if (!await alertConfirm(message)) return
        const next = deleteLorebookEntries(sourceEntries, new Set([target.id!]))
        const retainedIds = new Set(next.map((item) => item.id).filter(Boolean))
        const removedIds = sourceEntries
            .map((item) => item.id)
            .filter((id): id is string => Boolean(id) && !retainedIds.has(id))
        const scopeStillActive = stateScopeOwner?.key === targetScopeOwner?.key
        if (scopeStillActive) normalizedEntries = next
        targetOnChange(next)
        targetLocalActivation?.onEntriesRemoved?.(removedIds)
        if (!scopeStillActive) return
        selectedIds.delete(target.id!)
        selectedIds = new Set(selectedIds)
        activeId = null
        mobileView = 'list'
    }

    function childLabel(entry: loreBook): string {
        const id = entry.id ?? ''
        return resolveChildLabel?.(id)?.trim() || language.lorebookWorkspace.untitledLore
    }

    async function deactivateChild() {
        if (!activeEntry?.id || activeEntry.mode !== 'child') return
        const target = activeEntry
        if (!await alertConfirm(language.lorebookWorkspace.deactivateLinkConfirm(childLabel(target)))) return
        emit(deleteLorebookEntries(normalizedEntries, new Set([target.id])))
        activeId = null
        mobileView = 'list'
    }

    function moveActive(direction: 'up' | 'down') {
        if (!activeEntry?.id) return
        const base = commitAllDirty()
        const candidates = activeEntry.mode === 'folder'
            ? base.filter((item) => item.mode === 'folder' || !item.folder)
            : base
        const index = candidates.findIndex((item) => item.id === activeEntry.id)
        const target = candidates[index + (direction === 'up' ? -1 : 1)]
        if (!target?.id) return
        emit(moveLorebookEntries(
            base,
            [activeEntry.id],
            target.id,
            direction === 'up' ? 'before' : 'after',
        ))
    }

    function moveActiveToFolder() {
        if (!activeEntry?.id || !targetFolderId || targetFolderId === activeEntry.id) return
        const base = commitAllDirty()
        emit(moveLorebookEntries(base, [activeEntry.id], targetFolderId, 'inside'))
    }

    function moveActiveToRoot() {
        if (!activeEntry?.id || !activeEntry.folder) return
        const base = commitAllDirty()
        const target = base.find((item) => item.mode === 'folder' && item.id !== activeEntry.id)
            ?? base.find((item) => !item.folder && item.id !== activeEntry.id)
        if (!target?.id) return
        emit(moveLorebookEntries(base, [activeEntry.id], target.id, 'after'))
    }

    function restoreLoremaster() {
        if (!legacyDisabledBackups) return
        const base = commitAllDirty()
        const result = migrateLoremasterDisabledEntries(
            base as Array<loreBook & { disabled?: boolean }>,
            legacyDisabledBackups,
        )
        if (result.changed) {
            emit(result.entries)
            notifySuccess(language.lorebookWorkspace.importLoremasterResult(result.restoredIds.length))
        }
    }

    function rowIsVisible(item: loreBook): boolean {
        if (!item.folder || query) return true
        const parent = folderByKey.get(item.folder)
        return !parent?.id || expandedFolderIds.has(parent.id)
    }

    function toggleFolder(id: string) {
        const next = new Set(expandedFolderIds)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        expandedFolderIds = next
    }

    function resolveDropPosition(
        target: HTMLElement,
        clientY: number | undefined,
        rect: { top: number; height: number } = target.getBoundingClientRect(),
    ): LorebookDropPosition {
        if (clientY === undefined) return 'after'
        const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5
        if (target.dataset.lorebookFolder === 'true' && ratio >= 0.25 && ratio <= 0.75) {
            return 'inside'
        }
        return ratio < 0.5 ? 'before' : 'after'
    }

    function getClientY(event: Event | undefined): number | undefined {
        if (!event) return undefined
        const touchEvent = event as Event & {
            touches?: ArrayLike<{ clientY: number }>
            changedTouches?: ArrayLike<{ clientY: number }>
        }
        const touch = touchEvent.touches?.[0] ?? touchEvent.changedTouches?.[0]
        if (touch && Number.isFinite(touch.clientY)) return touch.clientY
        const clientY = (event as MouseEvent).clientY
        return Number.isFinite(clientY) ? clientY : undefined
    }

    function sourceIdsFor(draggedId: string): string[] {
        return selectedIds.has(draggedId) ? [...selectedIds] : [draggedId]
    }

    function fallbackDropTarget(sourceIds: Set<string>, clientY: number | undefined): HTMLElement | null {
        if (!listElement) return null
        const candidates = [...listElement.querySelectorAll<HTMLElement>('[data-lorebook-row]')]
            .filter((row) => Boolean(row.dataset.lorebookRow) && !sourceIds.has(row.dataset.lorebookRow!))
        if (candidates.length === 0) return null
        if (clientY === undefined) return candidates[0]
        const measured = candidates.map((row) => ({ row, rect: row.getBoundingClientRect() }))
        return measured.reduce((closest, candidate) => {
            const distance = (rect: { top: number; bottom: number }) => {
                if (clientY < rect.top) return rect.top - clientY
                if (clientY > rect.bottom) return clientY - rect.bottom
                return 0
            }
            return distance(candidate.rect) < distance(closest.rect) ? candidate : closest
        }).row
    }

    function restoreDraggedDom() {
        if (!dragOrigin) return
        const { item, parent, nextSibling } = dragOrigin
        if (nextSibling?.parentNode === parent) parent.insertBefore(item, nextSibling)
        else parent.appendChild(item)
        dragOrigin = null
    }

    function createSortable(element: HTMLElement): Sortable {
        return Sortable.create(element, {
            draggable: '[data-lorebook-row]',
            handle: '[data-lorebook-drag-handle]',
            delayOnTouchOnly: true,
            delay: 300,
            onStart(event) {
                dropIntent = null
                dragOrigin = {
                    item: event.item,
                    parent: event.item.parentNode!,
                    nextSibling: event.item.nextSibling,
                }
            },
            onMove(event, originalEvent) {
                const draggedId = event.dragged.dataset.lorebookRow
                if (!draggedId) return false
                const sourceIds = new Set(sourceIdsFor(draggedId))
                const clientY = getClientY(originalEvent)
                const relatedRow = event.related.closest<HTMLElement>('[data-lorebook-row]')
                const relatedId = relatedRow?.dataset.lorebookRow
                const target = relatedRow && relatedId && !sourceIds.has(relatedId)
                    ? relatedRow
                    : fallbackDropTarget(sourceIds, clientY)
                const targetId = target?.dataset.lorebookRow
                if (!target || !targetId) {
                    dropIntent = null
                    return false
                }
                const targetRect = target === relatedRow
                    ? event.relatedRect
                    : target.getBoundingClientRect()
                dropIntent = {
                    targetId,
                    position: resolveDropPosition(target, clientY, targetRect),
                }
                return true
            },
            onEnd(event) {
                const sourceId = (event.item as HTMLElement).dataset.lorebookRow
                const intent = dropIntent
                dropIntent = null
                restoreDraggedDom()
                if (!sourceId || !intent) return
                const sourceIds = sourceIdsFor(sourceId)
                if (sourceIds.includes(intent.targetId)) return
                const base = commitAllDirty()
                emit(moveLorebookEntries(
                    base,
                    sourceIds,
                    intent.targetId,
                    intent.position,
                ))
            },
        })
    }

    onMount(() => {
        const media = window.matchMedia?.('(max-width: 899px)')
        const sync = () => mobileViewport = media?.matches ?? false
        sync()
        media?.addEventListener?.('change', sync)
        return () => media?.removeEventListener?.('change', sync)
    })

    $effect(() => {
        const element = listElement
        const enabled = dragEnabled && !(mobileViewport && DBState.db.disableMobileDragDrop)
        if (!element || !enabled) {
            sortable?.destroy()
            sortable = undefined
            restoreDraggedDom()
            return
        }
        sortable?.destroy()
        const instance = createSortable(element)
        sortable = instance
        return () => {
            if (sortable === instance) sortable = undefined
            instance.destroy()
            restoreDraggedDom()
        }
    })
</script>

<section
    bind:this={workspaceElement}
    class="lore-workspace"
    aria-label={language.lorebookWorkspace.workspaceLabel(scopeLabel)}
    onfocusin={(event) => rememberFocus(event.target)}
    onfocusout={(event) => rememberFocus(event.target)}
>
        <header class="lore-toolbar" data-lorebook-toolbar>
            <div class="scope-mark"><strong>{scopeLabel}</strong><small>{language.lorebookWorkspace.entriesCount(normalizedEntries.length)}</small></div>
            <label class="search-box">
                <span class="sr-only">{language.lorebookWorkspace.search}</span>
                <input data-lorebook-search bind:value={query} placeholder={language.lorebookWorkspace.search} />
            </label>
            <select
                data-lorebook-search-target
                value={searchTarget}
                aria-label={language.lorebookWorkspace.searchTarget}
                onchange={(event) => searchTarget = event.currentTarget.value as typeof searchTarget}
            >
                <option value="name">{language.lorebookWorkspace.searchName}</option>
                <option value="keys">{language.lorebookWorkspace.searchKeys}</option>
            </select>
            <select
                data-lorebook-enabled-filter
                value={enabledFilter}
                aria-label={language.lorebookWorkspace.enabledFilter}
                onchange={(event) => enabledFilter = event.currentTarget.value as typeof enabledFilter}
            >
                <option value="all">{language.lorebookWorkspace.showAll}</option>
                <option value="enabled">{language.lorebookWorkspace.showEnabled}</option>
                <option value="disabled">{language.lorebookWorkspace.showDisabled}</option>
            </select>
            <button type="button" class="toolbar-action primary" data-lorebook-add onclick={() => addEntry()}>
                <SolarIcon src={documentAddIcon} name="document-add-bold" size="1.15rem" />
                <span>{language.lorebookWorkspace.addLore}</span>
            </button>
            <button type="button" class="toolbar-action" data-lorebook-add-folder onclick={() => addEntry('folder')}>
                <SolarIcon src={addFolderIcon} name="add-folder-bold" size="1.15rem" />
                <span>{language.lorebookWorkspace.addFolder}</span>
            </button>
            <button type="button" class="toolbar-action" data-lorebook-import onclick={() => void onImport?.()}>
                <SolarIcon src={fileDownloadIcon} name="file-download-bold" size="1.15rem" />
                <span>{language.lorebookWorkspace.import}</span>
            </button>
            <button type="button" class="toolbar-action" data-lorebook-export onclick={() => void onExport?.()}>
                <SolarIcon src={fileSendIcon} name="file-send-bold" size="1.15rem" />
                <span>{language.lorebookWorkspace.export}</span>
            </button>
            {#if restorableCount > 0}
                <button type="button" class="restore" data-lorebook-import-loremaster onclick={restoreLoremaster}>
                    <SolarIcon src={folderOpenIcon} name="folder-open-bold" size="1.15rem" />
                    <span>{language.lorebookWorkspace.importLoremaster} ({restorableCount})</span>
                </button>
            {/if}
        </header>

    <aside
        class="lore-pane lore-list-pane"
        data-lorebook-list
        data-mobile-hidden={mobileView === 'editor'}
    >

        <div class="lore-rows" bind:this={listElement}>
            {#each visibleEntries as item (item.id)}
                {#if rowIsVisible(item)}
                    <div
                        class:active={item.id === activeId}
                        class:selected={Boolean(item.id && selectedIds.has(item.id))}
                        class:folder={item.mode === 'folder'}
                        data-lorebook-row={item.id}
                        data-lorebook-folder={item.mode === 'folder'}
                        data-folder-key={item.folder ?? ''}
                    >
                        <button
                            type="button"
                            class="drag-handle"
                            data-lorebook-drag-handle
                            tabindex="-1"
                            aria-label={language.lorebookWorkspace.dragEntry(item.comment || language.lorebookWorkspace.untitledLore)}
                            title={dragEnabled && !(mobileViewport && DBState.db.disableMobileDragDrop)
                                ? language.lorebookWorkspace.dragEnabledHelp
                                : language.lorebookWorkspace.dragDisabledHelp}
                        ><SolarIcon src={dragIcon} name="hamburger-menu-bold" size="1.05rem" /></button>
                        {#if item.mode === 'folder'}
                            <button
                                type="button"
                                class="folder-disclosure"
                                data-lorebook-folder-toggle
                                aria-label={language.lorebookWorkspace.toggleFolder(item.comment || language.lorebookWorkspace.untitledFolder)}
                                aria-expanded={Boolean(item.id && expandedFolderIds.has(item.id))}
                                onclick={() => item.id && toggleFolder(item.id)}
                            >
                                {#if item.id && expandedFolderIds.has(item.id)}
                                    <SolarIcon src={squareAltArrowDownIcon} name="square-alt-arrow-down-bold" size="1.35rem" />
                                {:else}
                                    <SolarIcon src={squareAltArrowRightIcon} name="square-alt-arrow-right-bold" size="1.35rem" />
                                {/if}
                            </button>
                        {:else if item.mode !== 'child'}
                            <label class="row-select-hit-area">
                                <input
                                    type="checkbox"
                                    data-lorebook-select={item.id}
                                    aria-label={language.lorebookWorkspace.selectEntry(item.comment || language.lorebookWorkspace.untitledLore)}
                                    checked={Boolean(item.id && selectedIds.has(item.id))}
                                    onclick={(event) => item.id && selectFromCheckbox(item.id, event)}
                                />
                            </label>
                        {:else}
                            <span class="child-glyph" aria-label={language.lorebookWorkspace.globalLoreLink}>↗</span>
                        {/if}
                        <button
                            type="button"
                            class="row-main"
                            data-lorebook-open={item.mode === 'folder' ? undefined : ''}
                            data-lorebook-folder-edit={item.mode === 'folder' ? '' : undefined}
                            onclick={(event) => item.id && openEntry(item.id, event)}
                        >
                            <span class="row-title">
                                <SolarIcon
                                    src={item.mode === 'folder' ? folderIcon : editIcon}
                                    name={item.mode === 'folder' ? 'folder-bold' : 'pen-2-bold'}
                                    size="1rem"
                                />
                                <strong>{item.mode === 'child' ? childLabel(item) : item.comment || language.lorebookWorkspace.untitledLore}</strong>
                            </span>
                            <small>{item.mode === 'child'
                                ? `${language.lorebookWorkspace.globalLoreLink} · ${childLabel(item)}`
                                : item.mode === 'folder'
                                    ? language.lorebookWorkspace.entriesCount(folderChildCounts.get(item.key) ?? 0)
                                    : item.key || language.lorebookWorkspace.noKeys}</small>
                            <span class="sr-only" data-lorebook-status>
                                {item.enabled === false ? language.lorebookWorkspace.disabled : language.lorebookWorkspace.enabled}
                            </span>
                        </button>
                        <span aria-hidden="true" class:off={item.enabled === false} class="state-dot" title={item.enabled === false ? language.lorebookWorkspace.disabled : language.lorebookWorkspace.enabled}></span>
                    </div>
                {/if}
            {/each}
            {#if visibleEntries.length === 0}
                <p class="empty">{language.lorebookWorkspace.noMatches}</p>
            {/if}
        </div>

        {#if selectedIds.size > 0}
            <section class="batch-sheet" data-lorebook-batch aria-label={language.lorebookWorkspace.batchEdit}>
                <div class="batch-heading">
                    <strong>{language.lorebookWorkspace.selectedCount(selectedIds.size)}</strong>
                    <button type="button" data-lorebook-clear-selection onclick={clearSelection}>
                        <SolarIcon src={clearIcon} name="close-circle-bold" size="1.05rem" />
                        <span>{language.lorebookWorkspace.clearSelection}</span>
                    </button>
                </div>
                <div class="batch-actions">
                    <button type="button" data-lorebook-batch-enabled="true" onclick={() => batchPatch({ enabled: true })}>{language.lorebookWorkspace.enable}</button>
                    <button type="button" data-lorebook-batch-enabled="false" onclick={() => batchPatch({ enabled: false })}>{language.lorebookWorkspace.disable}</button>
                    <button type="button" onclick={() => batchPatch({ alwaysActive: true })}>{language.lorebookWorkspace.alwaysOn}</button>
                    <button type="button" onclick={() => batchPatch({ alwaysActive: false })}>{language.lorebookWorkspace.keyActive}</button>
                    <button type="button" onclick={() => batchPatch({ selective: true })}>{language.lorebookWorkspace.selective}</button>
                    <button type="button" onclick={() => batchPatch({ selective: false })}>{language.lorebookWorkspace.anyKey}</button>
                    <button type="button" onclick={() => batchPatch({ useRegex: true })}>{language.lorebookWorkspace.useRegex}</button>
                    <button type="button" onclick={() => batchPatch({ useRegex: false })}>{language.lorebookWorkspace.plainKeys}</button>
                </div>
                <div class="batch-keys">
                    <input bind:value={batchKeys} aria-label={language.lorebookWorkspace.batchKeys} placeholder={language.lorebookWorkspace.batchKeysPlaceholder} />
                    <button type="button" onclick={() => batchKeysChange('key', false)}>{language.lorebookWorkspace.addPrimaryKeys}</button>
                    <button type="button" onclick={() => batchKeysChange('key', true)}>{language.lorebookWorkspace.removePrimaryKeys}</button>
                    <button type="button" onclick={() => batchKeysChange('secondkey', false)}>{language.lorebookWorkspace.addSecondaryKeys}</button>
                    <button type="button" onclick={() => batchKeysChange('secondkey', true)}>{language.lorebookWorkspace.removeSecondaryKeys}</button>
                </div>
            </section>
        {/if}
    </aside>

    <button type="button" class="lore-splitter" data-lorebook-splitter aria-label={language.lorebookWorkspace.resizeList}></button>

    <main
        bind:this={editorElement}
        class="lore-pane lore-editor-pane"
        data-lorebook-editor
        data-mobile-hidden={mobileView === 'list'}
    >
        <button type="button" class="mobile-back" data-lorebook-back onclick={() => mobileView = 'list'}>
            <SolarIcon src={altArrowLeftIcon} name="alt-arrow-left-bold" size="1.15rem" />
            <span>{language.lorebookWorkspace.back}</span>
        </button>
        {#if activeEntry?.mode === 'child'}
            <section class="child-link-editor" data-lorebook-child-link>
                <span class="child-link-mark" aria-hidden="true">↗</span>
                <strong>{language.lorebookWorkspace.globalLoreLink}</strong>
                <p>{language.lorebookWorkspace.compatibilityLinkDescription}</p>
                <p data-lorebook-child-label><strong>{language.lorebookWorkspace.linkedLore}:</strong> {childLabel(activeEntry)}</p>
                <label>{language.lorebookWorkspace.name} <input value={activeEntry.comment} disabled /></label>
                <label>{language.lorebookWorkspace.referenceKey} <input value={activeEntry.key} disabled /></label>
                <button type="button" class="danger action-with-icon" data-lorebook-deactivate-child onclick={deactivateChild}>
                    <SolarIcon src={trashIcon} name="trash-bin-2-bold" size="1.1rem" />
                    <span>{language.lorebookWorkspace.deactivateLink}</span>
                </button>
            </section>
        {:else if activeEntry && activeEntry.mode !== 'folder'}
            <div class="lore-editor-grid">
                <div class="editor-fields">
                    <div class="editor-heading">
                        <label>{language.lorebookWorkspace.name}
                            <input
                                data-lorebook-field="comment"
                                value={drafts.comment}
                                oninput={(event) => markDraftDirty('comment', event.currentTarget.value)}
                                onblur={() => commitDraft('comment')}
                                onkeydown={(event) => commitOnShortcut(event, 'comment')}
                            />
                        </label>
                        <label>{language.lorebookWorkspace.order}
                            <input
                                type="number"
                                data-lorebook-field="insertorder"
                                value={drafts.insertorder}
                                oninput={(event) => markDraftDirty('insertorder', event.currentTarget.value)}
                                onblur={() => commitDraft('insertorder')}
                                onkeydown={(event) => commitOnShortcut(event, 'insertorder')}
                            />
                        </label>
                    </div>
                    <label>{language.lorebookWorkspace.primaryKeys}
                        <input
                            data-lorebook-field="key"
                            value={drafts.key}
                            oninput={(event) => markDraftDirty('key', event.currentTarget.value)}
                            onblur={() => commitDraft('key')}
                            onkeydown={(event) => commitOnShortcut(event, 'key')}
                        />
                    </label>
                    <label>{language.lorebookWorkspace.secondaryKeys}
                        <input
                            data-lorebook-field="secondkey"
                            value={drafts.secondkey}
                            oninput={(event) => markDraftDirty('secondkey', event.currentTarget.value)}
                            onblur={() => commitDraft('secondkey')}
                            onkeydown={(event) => commitOnShortcut(event, 'secondkey')}
                        />
                    </label>
                    <label class="content-field">{language.lorebookWorkspace.content}
                        <textarea
                            class="lore-content"
                            data-lorebook-field="content"
                            value={drafts.content}
                            oninput={(event) => markDraftDirty('content', event.currentTarget.value)}
                            onblur={() => commitDraft('content')}
                            onkeydown={(event) => commitOnShortcut(event, 'content')}
                        ></textarea>
                    </label>
                </div>
                <aside class="lore-state-rail" aria-label={language.lorebookWorkspace.loreState}>
                    {#if localActivation?.visible}
                        <label><input
                            type="checkbox"
                            data-lorebook-local-activation
                            checked={localActivation.isActive(activeEntry)}
                            onchange={(event) => localActivation?.onToggle(activeEntry, event.currentTarget.checked)}
                        /> {language.lorebookWorkspace.activeInCurrentChat}</label>
                    {/if}
                    <label><input type="checkbox" checked={activeEntry.enabled !== false} onchange={(event) => patchEntry(activeEntry.id!, { enabled: event.currentTarget.checked })} /> {language.lorebookWorkspace.enabled}</label>
                    <label><input type="checkbox" checked={activeEntry.alwaysActive} onchange={(event) => patchEntry(activeEntry.id!, { alwaysActive: event.currentTarget.checked })} /> {language.lorebookWorkspace.alwaysActive}</label>
                    <label><input type="checkbox" checked={activeEntry.selective} onchange={(event) => patchEntry(activeEntry.id!, { selective: event.currentTarget.checked })} /> {language.lorebookWorkspace.selective}</label>
                    <label><input type="checkbox" checked={activeEntry.useRegex ?? false} onchange={(event) => patchEntry(activeEntry.id!, { useRegex: event.currentTarget.checked })} /> {language.lorebookWorkspace.regexKeys}</label>
                    <label class="activation-control">{language.lorebookWorkspace.activationPercent}
                        <input
                            type="number"
                            min="0"
                            max="100"
                            data-lorebook-activation-percent
                            value={activeEntry.activationPercent ?? 100}
                            onchange={(event) => patchEntry(activeEntry.id!, {
                                activationPercent: Math.min(100, Math.max(0, Number(event.currentTarget.value) || 0)),
                            })}
                        />
                    </label>
                    <hr />
                    <button type="button" class="action-with-icon" data-lorebook-move="up" onclick={() => moveActive('up')}>
                        <SolarIcon src={altArrowUpIcon} name="alt-arrow-up-bold" size="1.05rem" />
                        <span>{language.lorebookWorkspace.moveUp}</span>
                    </button>
                    <button type="button" class="action-with-icon" data-lorebook-move="down" onclick={() => moveActive('down')}>
                        <SolarIcon src={altArrowDownIcon} name="alt-arrow-down-bold" size="1.05rem" />
                        <span>{language.lorebookWorkspace.moveDown}</span>
                    </button>
                    <select bind:value={targetFolderId} aria-label={language.lorebookWorkspace.moveTargetFolder}>
                        <option value="">{language.lorebookWorkspace.chooseFolder}</option>
                        {#each folders as folder}
                            <option value={folder.id}>{folder.comment || language.lorebookWorkspace.untitledFolder}</option>
                        {/each}
                    </select>
                    <button type="button" class="action-with-icon" data-lorebook-move="folder" onclick={moveActiveToFolder}>
                        <SolarIcon src={moveToFolderIcon} name="move-to-folder-bold" size="1.05rem" />
                        <span>{language.lorebookWorkspace.moveToFolder}</span>
                    </button>
                    <button type="button" class="action-with-icon" data-lorebook-move="root" onclick={moveActiveToRoot}>
                        <SolarIcon src={folderOpenIcon} name="folder-open-bold" size="1.05rem" />
                        <span>{language.lorebookWorkspace.moveToRoot}</span>
                    </button>
                    <button type="button" class="danger action-with-icon" data-lorebook-delete onclick={removeActive}>
                        <SolarIcon src={trashIcon} name="trash-bin-2-bold" size="1.05rem" />
                        <span>{language.lorebookWorkspace.deleteEntry}</span>
                    </button>
                </aside>
            </div>
        {:else if activeEntry?.mode === 'folder'}
            <div class="folder-editor" data-lorebook-folder-editor>
                <div class="folder-editor-card">
                    <span class="folder-kicker">{language.lorebookWorkspace.archiveFolder}</span>
                    <label>{language.lorebookWorkspace.name}
                        <input
                            data-lorebook-folder-name
                            value={drafts.comment}
                            oninput={(event) => markDraftDirty('comment', event.currentTarget.value)}
                            onblur={() => commitDraft('comment')}
                            onkeydown={(event) => commitOnShortcut(event, 'comment')}
                        />
                    </label>
                    <label>{language.lorebookWorkspace.order}
                        <input
                            type="number"
                            value={drafts.insertorder}
                            oninput={(event) => markDraftDirty('insertorder', event.currentTarget.value)}
                            onblur={() => commitDraft('insertorder')}
                            onkeydown={(event) => commitOnShortcut(event, 'insertorder')}
                        />
                    </label>
                    <div class="folder-actions">
                        <button type="button" class="action-with-icon" data-lorebook-move="up" onclick={() => moveActive('up')}>
                            <SolarIcon src={altArrowUpIcon} name="alt-arrow-up-bold" size="1.05rem" />
                            <span>{language.lorebookWorkspace.moveUp}</span>
                        </button>
                        <button type="button" class="action-with-icon" data-lorebook-move="down" onclick={() => moveActive('down')}>
                            <SolarIcon src={altArrowDownIcon} name="alt-arrow-down-bold" size="1.05rem" />
                            <span>{language.lorebookWorkspace.moveDown}</span>
                        </button>
                        <button type="button" class="danger action-with-icon" data-lorebook-delete onclick={removeActive}>
                            <SolarIcon src={trashIcon} name="trash-bin-2-bold" size="1.05rem" />
                            <span>{language.lorebookWorkspace.deleteFolderAndEntries}</span>
                        </button>
                    </div>
                </div>
            </div>
        {:else}
            <div class="editor-empty">
                <span>⌘</span>
                <strong>{language.lorebookWorkspace.selectLoreEntry}</strong>
                <p>{language.lorebookWorkspace.emptyEditorDescription}</p>
            </div>
        {/if}
    </main>
</section>

<style>
    .lore-workspace {
        --lore-list-ratio: 38%;
        --lore-list-width: clamp(26%, var(--lore-list-ratio, 38%), 52%);
        --lore-effective-list-width: max(19rem, var(--lore-list-width, 38%));
        position: relative;
        display: grid;
        container-type: inline-size;
        container-name: lore-workbench;
        grid-template-rows: auto minmax(0, 1fr);
        grid-template-columns:
            minmax(19rem, var(--lore-list-width, 38%))
            minmax(0, 1fr);
        min-width: 0;
        height: 100%;
        overflow: hidden;
        border: 1px solid var(--color-darkborderc);
        border-radius: .65rem;
        background: var(--color-darkbg);
        color: var(--color-textcolor);
        font-size: 110%;
    }
    .lore-pane { min-width: 0; min-height: 0; }
    .lore-list-pane { position: relative; display: flex; grid-row: 2; grid-column: 1; flex-direction: column; border-right: 1px solid var(--color-darkborderc); background: color-mix(in srgb, var(--color-darkbg) 91%, var(--color-selected) 9%); }
    .lore-toolbar { position: relative; z-index: 6; display: flex; grid-row: 1; grid-column: 1 / -1; flex-wrap: nowrap; align-items: center; gap: .45rem; padding: .68rem; border-bottom: 1px solid var(--color-darkborderc); background: color-mix(in srgb, var(--color-darkbg) 94%, var(--color-selected) 6%); }
    .scope-mark { display: grid; min-width: 8.5rem; margin-right: .35rem; padding-left: .55rem; border-left: .25rem solid var(--color-borderc); }
    .scope-mark strong { overflow: hidden; font-size: .9rem; font-weight: 750; text-overflow: ellipsis; white-space: nowrap; }
    .scope-mark small { color: var(--color-textcolor2); font: .68rem ui-monospace, monospace; }
    .search-box { min-width: 7rem; flex: 1; }
    input, textarea, select { border: 1px solid var(--color-darkborderc); border-radius: .48rem; background: color-mix(in srgb, var(--color-darkbg) 92%, var(--color-selected) 8%); color: var(--color-textcolor); font-size: .8rem; }
    button { border: 0; border-radius: .5rem; background: color-mix(in srgb, var(--color-selected) 38%, var(--color-darkbg)); color: var(--color-textcolor); font-size: .8rem; font-weight: 650; }
    input, textarea, select { outline: none; }
    input:focus, textarea:focus, select:focus, button:focus-visible { border-color: var(--color-borderc); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-selected) 65%, transparent); }
    .lore-toolbar input { width: 100%; height: 2.15rem; padding: 0 .65rem; }
    .lore-toolbar select, .lore-toolbar button { height: 2.15rem; padding: 0 .62rem; white-space: nowrap; }
    button { cursor: pointer; }
    button:hover { background: color-mix(in srgb, var(--color-selected) 72%, var(--color-darkbg)); }
    .toolbar-action, .restore, .action-with-icon, .batch-heading button { display: inline-flex; align-items: center; justify-content: center; gap: .38rem; }
    .toolbar-action.primary { background: var(--color-selected); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-borderc) 55%, transparent); }
    .restore { background: color-mix(in srgb, var(--color-borderc) 28%, var(--color-darkbg)); }
    .lore-rows { min-height: 0; flex: 1; overflow-y: auto; padding: .6rem; padding-bottom: 9rem; }
    [data-lorebook-row] { position: relative; display: grid; grid-template-columns: auto auto minmax(0, 1fr) auto; align-items: center; content-visibility: auto; contain-intrinsic-size: auto 3.05rem; gap: .48rem; min-height: 3.05rem; margin-bottom: .32rem; padding: .42rem .55rem; border: 1px solid transparent; border-radius: .62rem; background: color-mix(in srgb, var(--color-darkbg) 90%, var(--color-selected) 10%); cursor: default; }
    [data-lorebook-row]:hover { border-color: color-mix(in srgb, var(--color-borderc) 55%, transparent); background: color-mix(in srgb, var(--color-selected) 28%, var(--color-darkbg)); }
    [data-lorebook-row].selected { border-color: color-mix(in srgb, var(--color-borderc) 78%, transparent); background: color-mix(in srgb, var(--color-selected) 55%, var(--color-darkbg)); }
    [data-lorebook-row].active { border-color: var(--color-borderc); box-shadow: inset .22rem 0 0 var(--color-borderc), 0 0 0 1px color-mix(in srgb, var(--color-borderc) 24%, transparent); }
    [data-lorebook-row][data-folder-key]:not([data-folder-key='']) { margin-left: 2rem; }
    [data-lorebook-row][data-folder-key]:not([data-folder-key=''])::before { position: absolute; top: -.5rem; bottom: -.5rem; left: -1.05rem; width: .8rem; border-bottom: 2px solid color-mix(in srgb, var(--color-borderc) 50%, transparent); border-left: 2px solid color-mix(in srgb, var(--color-borderc) 50%, transparent); border-radius: 0 0 0 .45rem; content: ''; pointer-events: none; }
    [data-lorebook-row].folder { min-height: 3.3rem; margin-top: .45rem; border-color: color-mix(in srgb, var(--color-borderc) 35%, transparent); background: color-mix(in srgb, var(--color-selected) 34%, var(--color-darkbg)); box-shadow: inset .24rem 0 0 color-mix(in srgb, var(--color-borderc) 75%, transparent); }
    [data-lorebook-drag-handle] { display: grid; width: 1.8rem; height: 1.8rem; padding: 0; place-items: center; background: color-mix(in srgb, var(--color-selected) 22%, transparent); color: var(--color-textcolor2); cursor: grab; }
    .folder-disclosure { display: grid; width: 2.15rem; height: 2.15rem; padding: 0; place-items: center; background: color-mix(in srgb, var(--color-borderc) 24%, var(--color-darkbg)); color: var(--color-borderc); }
    .row-select-hit-area { display: contents; }
    .child-glyph { color: var(--color-textcolor2); font-size: .85rem; }
    .row-main { display: grid; min-width: 0; gap: .12rem; padding: .12rem .2rem; border: 0; background: transparent; text-align: left; }
    .row-main:hover { background: transparent; }
    .row-title { display: flex; min-width: 0; align-items: center; gap: .42rem; }
    .row-title strong, .row-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-title strong { font-size: .84rem; }
    .folder .row-title strong { font-size: .88rem; font-weight: 800; letter-spacing: .01em; }
    .row-main small { padding-left: 1.42rem; color: var(--color-textcolor2); font: .69rem ui-monospace, monospace; }
    .state-dot { width: .42rem; height: .42rem; border-radius: 50%; background: var(--color-borderc); }
    .state-dot.off { background: var(--color-textcolor2); opacity: .35; }
    .empty { padding: 2rem; color: var(--color-textcolor2); text-align: center; }
    .batch-sheet { position: absolute; right: .65rem; bottom: .65rem; left: .65rem; z-index: 3; display: grid; gap: .48rem; padding: .65rem; border: 1px solid var(--color-borderc); border-radius: .75rem; background: color-mix(in srgb, var(--color-darkbg) 90%, var(--color-selected) 10%); box-shadow: 0 .7rem 2rem rgb(0 0 0 / .28); }
    .batch-heading { display: flex; align-items: center; justify-content: space-between; gap: .6rem; }
    .batch-heading strong { font-size: .78rem; }
    .batch-heading button { padding: .38rem .52rem; }
    .batch-actions, .batch-keys { display: flex; flex-wrap: wrap; gap: .28rem; }
    .batch-sheet button { padding: .3rem .4rem; }
    .batch-keys input { min-width: 8rem; flex: 1; padding: .3rem .42rem; }
    .lore-splitter { position: absolute; top: 0; bottom: 0; left: calc(var(--lore-effective-list-width) - .25rem); z-index: 5; width: .5rem; border: 0; border-radius: 0; background: transparent; cursor: col-resize; touch-action: none; }
    .lore-splitter:hover, .lore-splitter:focus-visible { background: color-mix(in srgb, var(--color-borderc) 45%, transparent); box-shadow: none; }
    .lore-editor-pane { display: flex; grid-row: 2; grid-column: 2; flex-direction: column; background: color-mix(in srgb, var(--color-darkbg) 98%, black); }
    .mobile-back { display: none; }
    .lore-editor-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 12rem;
        min-height: 0;
        height: 100%;
    }
    .editor-fields { display: flex; min-width: 0; min-height: 0; flex-direction: column; gap: .7rem; padding: .9rem; }
    .editor-heading { display: grid; grid-template-columns: minmax(0, 1fr) 7rem; gap: .7rem; }
    .editor-fields label { display: grid; gap: .3rem; color: var(--color-textcolor2); font-size: .74rem; font-weight: 650; letter-spacing: .02em; }
    .editor-fields input, .editor-fields textarea { width: 100%; padding: .48rem .55rem; color: var(--color-textcolor); }
    .content-field { min-height: 0; flex: 1; grid-template-rows: auto minmax(0, 1fr); }
    .lore-content {
        min-height: 18rem;
        height: 100%;
        resize: none;
        font: .86rem/1.6 ui-monospace, 'Cascadia Code', monospace;
    }
    .lore-state-rail { display: flex; min-height: 0; flex-direction: column; gap: .5rem; padding: .9rem; border-left: 1px solid var(--color-darkborderc); background: color-mix(in srgb, var(--color-selected) 15%, transparent); }
    .lore-state-rail label { display: flex; align-items: center; gap: .48rem; font-size: .77rem; }
    .lore-state-rail hr { width: 100%; border: 0; border-top: 1px solid var(--color-darkborderc); }
    .lore-state-rail button, .lore-state-rail select { width: 100%; min-height: 2.15rem; padding: .42rem; }
    .activation-control { display: grid !important; align-items: stretch !important; gap: .24rem !important; }
    .activation-control input { width: 100%; padding: .35rem; }
    .danger { background: color-mix(in srgb, #c85d5d 46%, var(--color-darkbg)); color: color-mix(in srgb, #ffffff 88%, #e98686); }
    .danger:hover { background: color-mix(in srgb, #c85d5d 72%, var(--color-darkbg)); }
    .editor-empty, .folder-editor, .child-link-editor { display: grid; height: 100%; place-content: center; gap: .35rem; padding: 2rem; color: var(--color-textcolor2); text-align: center; }
    .editor-empty span { font: 2rem Georgia, serif; opacity: .35; }
    .editor-empty strong, .child-link-editor strong { color: var(--color-textcolor); font-family: Georgia, 'Times New Roman', serif; }
    .editor-empty p { margin: 0; font-size: .8rem; }
    .folder-editor-card { display: grid; width: min(30rem, 80vw); gap: .85rem; padding: 1.3rem; border: 1px solid color-mix(in srgb, var(--color-borderc) 40%, var(--color-darkborderc)); border-radius: .8rem; background: color-mix(in srgb, var(--color-darkbg) 86%, var(--color-selected) 14%); box-shadow: inset .25rem 0 0 var(--color-borderc); text-align: left; }
    .folder-editor-card label, .child-link-editor label { display: grid; gap: .32rem; font-size: .75rem; font-weight: 650; }
    .folder-editor-card input, .child-link-editor input { padding: .5rem; }
    .folder-kicker { color: var(--color-textcolor2); font: 700 .69rem ui-monospace, monospace; letter-spacing: .11em; text-transform: uppercase; }
    .folder-actions { display: flex; flex-wrap: wrap; gap: .4rem; }
    .folder-actions button { padding: .42rem .55rem; }
    .child-link-editor { width: min(34rem, 90%); margin: auto; place-content: center stretch; }
    .child-link-editor p { margin: 0 0 .8rem; font-size: .8rem; }
    .child-link-mark { color: var(--color-borderc); font-size: 2rem; }

    @container lore-workbench (max-width: 1199px) {
        .lore-toolbar { flex-wrap: wrap; }
        .scope-mark { width: 100%; }
    }
    @media (max-width: 899px) {
        .lore-workspace { display: flex; flex-direction: column; border: 0; border-radius: 0; }
        .lore-pane { min-height: 0; height: auto; flex: 1; }
        .lore-pane[data-mobile-hidden='true'] { display: none; }
        .lore-list-pane { border-right: 0; }
        .lore-toolbar .search-box { flex-basis: 100%; }
        .lore-splitter { display: none; }
        .mobile-back { display: inline-flex; margin: .65rem .75rem 0; padding: .5rem .68rem; align-items: center; align-self: flex-start; gap: .4rem; }
        .lore-editor-grid { grid-template-columns: 1fr; height: calc(100% - 3rem); overflow-y: auto; }
        .editor-fields { min-height: 42rem; }
        .lore-state-rail {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            border-top: 1px solid var(--color-darkborderc);
            border-left: 0;
        }
        .lore-state-rail hr { grid-column: 1 / -1; }
        .batch-sheet { position: fixed; right: 0; bottom: 0; left: 0; border-radius: .7rem .7rem 0 0; padding-bottom: calc(.55rem + env(safe-area-inset-bottom)); }
        button, input, select { min-height: 3rem; touch-action: manipulation; }
        [data-lorebook-drag-handle], .folder-disclosure, .row-select-hit-area { min-width: 3rem; min-height: 3rem; }
        .row-select-hit-area { display: grid; min-width: 3rem; min-height: 3rem; place-items: center; }
        [data-lorebook-row] { min-height: 3.35rem; padding: .46rem .35rem; }
        [data-lorebook-row][data-folder-key]:not([data-folder-key='']) { margin-left: 1.4rem; }
        .toolbar-action { flex: 1 1 auto; }
        [data-lorebook-select] { width: 1rem; min-width: 1rem; height: 1rem; min-height: 1rem; margin: 0; }
        textarea { touch-action: manipulation; }
    }
</style>
