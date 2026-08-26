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
    import LoreBookStatusIcons from './LoreBookStatusIcons.svelte'
    import CbsConditionView from '../../UI/GUI/CbsConditionView.svelte'
    import { resizeHandle } from 'src/ts/gui/resizeHandle'
    import { loreBookVisualStatus } from './loreBookVisualStatus'
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
    import inlineTrashIcon from 'src/assets/solar-bold/trash-bin-trash-bold.svg'
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
    let dropIntent = $state<{ targetId: string; position: LorebookDropPosition } | null>(null)
    let draggingIds = $state(new Set<string>())
    let dragOrigin: { item: HTMLElement; parent: Node; nextSibling: ChildNode | null } | null = null
    let mobileViewport = $state(false)
    let conditionView = $state(false)
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
    let batchHiddenState = $derived(batchHiddenBooleanState())
    let batchAlwaysState = $derived(batchBooleanState('alwaysActive'))
    let batchSelectiveState = $derived(batchBooleanState('selective'))
    let batchRegexState = $derived(batchBooleanState('useRegex'))

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

    function startListResize() {
        const shell = workspaceElement
        const list = shell?.querySelector<HTMLElement>('.lore-list-pane')
        if (!shell || !list) return
        const width = shell.getBoundingClientRect().width
        const start = list.getBoundingClientRect().width
        return (dx: number) => shell.style.setProperty('--lore-list-ratio', `${Math.max(120, Math.min(width - 240, start + dx)) / width * 100}%`)
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
        if (activeId !== id && dirtyDraftFields.size > 0) emit(commitAllDirty())
        if (entry && isBatchEditable(entry)) {
            selectEntry(id, event)
        }
        else if (!event?.shiftKey && !event?.ctrlKey && !event?.metaKey) {
            clearSelection()
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

    type BatchBooleanField = 'enabled' | 'alwaysActive' | 'selective' | 'useRegex'

    function batchBooleanState(field: BatchBooleanField): boolean | 'mixed' {
        const selected = normalizedEntries.filter((entry) => entry.id && selectedIds.has(entry.id) && isBatchEditable(entry))
        const values = selected.map((entry) => field === 'enabled' ? entry.enabled !== false : Boolean(entry[field]))
        if (values.every(Boolean)) return true
        if (values.every((value) => !value)) return false
        return 'mixed'
    }

    function toggleBatchBoolean(field: BatchBooleanField) {
        const next = batchBooleanState(field) !== true
        batchPatch({ [field]: next })
    }

    function batchHiddenBooleanState(): boolean | 'mixed' {
        const selected = normalizedEntries.filter((entry) => entry.id && selectedIds.has(entry.id) && isBatchEditable(entry))
        const values = selected.map((entry) => entry.enabled === false)
        if (values.every(Boolean)) return true
        if (values.every((value) => !value)) return false
        return 'mixed'
    }

    function toggleBatchHidden() {
        const hidden = batchHiddenBooleanState() !== true
        batchPatch({ enabled: !hidden })
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

    async function removeEntry(id: string) {
        const target = normalizedEntries.find((entry) => entry.id === id)
        if (!target) return
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
        const removedIdSet = new Set(removedIds)
        selectedIds = new Set([...selectedIds].filter((selectedId) => !removedIdSet.has(selectedId)))
        if (activeId && removedIdSet.has(activeId)) {
            activeId = null
            mobileView = 'list'
        }
    }

    async function removeActive() {
        if (activeEntry?.id) await removeEntry(activeEntry.id)
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
            filter: '[data-lorebook-no-drag]',
            preventOnFilter: false,
            delayOnTouchOnly: true,
            delay: 300,
            onStart(event) {
                dropIntent = null
                const draggedId = event.item.dataset.lorebookRow
                draggingIds = new Set(draggedId ? sourceIdsFor(draggedId) : [])
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
                return false
            },
            onEnd(event) {
                const sourceId = (event.item as HTMLElement).dataset.lorebookRow
                const intent = dropIntent
                dropIntent = null
                draggingIds = new Set()
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
            draggingIds = new Set()
            dropIntent = null
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
    data-lorebook-drag-count={draggingIds.size || undefined}
    data-drag-enabled={dragEnabled && !(mobileViewport && DBState.db.disableMobileDragDrop)}
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
                    {@const visualStatus = loreBookVisualStatus(item)}
                    <div
                        class:active={item.id === activeId}
                        class:selected={Boolean(item.id && selectedIds.has(item.id))}
                        class:folder={item.mode === 'folder'}
                        class:hidden-entry={visualStatus.hidden}
                        class:unreachable-entry={visualStatus.unreachable && !visualStatus.hidden}
                        class:dragging-group={Boolean(item.id && draggingIds.has(item.id))}
                        data-lorebook-row={item.id}
                        data-lorebook-folder={item.mode === 'folder'}
                        data-folder-key={item.folder ?? ''}
                        data-drop-position={dropIntent?.targetId === item.id ? dropIntent.position : undefined}
                    >
                        {#if item.mode === 'folder'}
                            <button
                                type="button"
                                class="folder-disclosure"
                                data-lorebook-no-drag
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
                            <label class="row-select-hit-area" data-lorebook-no-drag>
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
                        <span class="row-actions" data-lorebook-no-drag>
                            <LoreBookStatusIcons entry={item} />
                            <button
                                type="button"
                                class="row-delete"
                                data-lorebook-row-delete={item.id}
                                aria-label={language.lorebookWorkspace.deleteEntry}
                                title={language.lorebookWorkspace.deleteEntry}
                                onclick={(event) => { event.stopPropagation(); item.id && void removeEntry(item.id) }}
                            >
                                <SolarIcon src={inlineTrashIcon} name="trash-bin-trash-bold" size="1.05rem" />
                            </button>
                        </span>
                    </div>
                {/if}
            {/each}
            {#if visibleEntries.length === 0}
                <p class="empty">{language.lorebookWorkspace.noMatches}</p>
            {/if}
        </div>

    </aside>

    <button type="button" class="lore-splitter" data-lorebook-splitter aria-label={language.lorebookWorkspace.resizeList}
        use:resizeHandle={{ start: startListResize, reset: () => workspaceElement?.style.setProperty('--lore-list-ratio', '38%') }}></button>

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
        {#if selectedIds.size > 1}
            <section class="batch-editor" data-lorebook-batch aria-label={language.lorebookWorkspace.batchEdit}>
                <header class="batch-heading">
                    <div>
                        <span class="batch-kicker">{language.lorebookWorkspace.batchEdit}</span>
                        <strong>{language.lorebookWorkspace.selectedCount(selectedIds.size)}</strong>
                    </div>
                    <button type="button" data-lorebook-clear-selection onclick={clearSelection}>
                        <SolarIcon src={clearIcon} name="close-circle-bold" size="1.05rem" />
                        <span>{language.lorebookWorkspace.clearSelection}</span>
                    </button>
                </header>
                <p class="batch-notice">{language.lorebookWorkspace.batchSelectionHelp}</p>
                <div class="batch-toggle-grid">
                    <button
                        type="button"
                        class="batch-toggle"
                        class:mixed={batchHiddenState === 'mixed'}
                        role="checkbox"
                        aria-checked={batchHiddenState}
                        data-lorebook-batch-enabled={batchHiddenState === true ? 'true' : 'false'}
                        onclick={toggleBatchHidden}
                    ><span>{language.lorebookWorkspace.hidden}</span><span class="toggle-mark" aria-hidden="true"></span></button>
                    <button type="button" class="batch-toggle" class:mixed={batchAlwaysState === 'mixed'} role="checkbox" aria-checked={batchAlwaysState} onclick={() => toggleBatchBoolean('alwaysActive')}>
                        <span>{language.lorebookWorkspace.alwaysActive}</span><span class="toggle-mark" aria-hidden="true"></span>
                    </button>
                    <button type="button" class="batch-toggle" class:mixed={batchSelectiveState === 'mixed'} role="checkbox" aria-checked={batchSelectiveState} onclick={() => toggleBatchBoolean('selective')}>
                        <span>{language.lorebookWorkspace.selective}</span><span class="toggle-mark" aria-hidden="true"></span>
                    </button>
                    <button type="button" class="batch-toggle" class:mixed={batchRegexState === 'mixed'} role="checkbox" aria-checked={batchRegexState} onclick={() => toggleBatchBoolean('useRegex')}>
                        <span>{language.lorebookWorkspace.regexKeys}</span><span class="toggle-mark" aria-hidden="true"></span>
                    </button>
                </div>
                <label class="batch-key-field">
                    <span>{language.lorebookWorkspace.batchKeys}</span>
                    <input bind:value={batchKeys} aria-label={language.lorebookWorkspace.batchKeys} placeholder={language.lorebookWorkspace.batchKeysPlaceholder} />
                </label>
                <div class="batch-key-actions">
                    <button type="button" onclick={() => batchKeysChange('key', false)}>{language.lorebookWorkspace.addPrimaryKeys}</button>
                    <button type="button" onclick={() => batchKeysChange('key', true)}>{language.lorebookWorkspace.removePrimaryKeys}</button>
                    <button type="button" onclick={() => batchKeysChange('secondkey', false)}>{language.lorebookWorkspace.addSecondaryKeys}</button>
                    <button type="button" onclick={() => batchKeysChange('secondkey', true)}>{language.lorebookWorkspace.removeSecondaryKeys}</button>
                </div>
                <p class="batch-drag-help">{language.lorebookWorkspace.dragSelectionHelp}</p>
            </section>
        {:else if activeEntry?.mode === 'child'}
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
                    <div class="content-field">
                        <div class="content-heading"><span>{language.lorebookWorkspace.content}</span><button type="button" data-cbs-view-toggle aria-pressed={conditionView} onclick={() => { commitDraft('content'); conditionView = !conditionView }}>{conditionView ? 'Source' : 'CBS branches'}</button></div>
                        {#if conditionView}
                            <CbsConditionView value={drafts.content} onInput={(value) => markDraftDirty('content', value)} onblur={() => commitDraft('content')} onkeydown={(event) => commitOnShortcut(event, 'content')} />
                        {:else}
                        <textarea
                            class="lore-content"
                            data-lorebook-field="content"
                            value={drafts.content}
                            oninput={(event) => markDraftDirty('content', event.currentTarget.value)}
                            onblur={() => commitDraft('content')}
                            onkeydown={(event) => commitOnShortcut(event, 'content')}
                        ></textarea>
                        {/if}
                    </div>
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
                    <label><input type="checkbox" data-lorebook-hidden checked={activeEntry.enabled === false} onchange={(event) => patchEntry(activeEntry.id!, { enabled: !event.currentTarget.checked })} /> {language.lorebookWorkspace.hidden}</label>
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
                    <details class="entry-actions">
                        <summary>{language.lorebookWorkspace.entryActions}</summary>
                        <div class="entry-action-list">
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
                        </div>
                    </details>
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
        --lore-surface-root: color-mix(in srgb, var(--color-darkbg) 98%, var(--color-selected) 2%);
        --lore-surface-folder: color-mix(in srgb, var(--color-darkbg) 94%, var(--color-borderc) 6%);
        --lore-surface-child: color-mix(in srgb, var(--color-darkbg) 96%, var(--color-selected) 4%);
        --lore-hierarchy-line: color-mix(in srgb, var(--color-borderc) 35%, var(--color-darkborderc));
        --lore-selection: color-mix(in srgb, var(--color-selected) 70%, var(--color-darkbg));
        --lore-drop-target: var(--color-primary);
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
        font-size: 100%;
    }
    .lore-pane { min-width: 0; min-height: 0; }
    .lore-list-pane { position: relative; display: flex; grid-row: 2; grid-column: 1; flex-direction: column; border-right: 1px solid var(--color-darkborderc); background: var(--lore-surface-root); }
    .lore-toolbar { position: relative; z-index: 6; display: flex; grid-row: 1; grid-column: 1 / -1; flex-wrap: nowrap; align-items: center; gap: .45rem; padding: .68rem; border-bottom: 1px solid var(--color-darkborderc); background: var(--color-darkbg); }
    .scope-mark { display: grid; min-width: 8.5rem; margin-right: .35rem; padding-left: .55rem; border-left: .25rem solid var(--color-borderc); }
    .scope-mark strong { overflow: hidden; font-size: .9rem; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .scope-mark small { color: var(--color-textcolor2); font-size: .68rem; font-weight: 400; }
    .search-box { min-width: 7rem; flex: 1; }
    input, textarea, select { border: 1px solid var(--color-darkborderc); border-radius: .48rem; background: color-mix(in srgb, var(--color-darkbg) 98%, var(--color-selected) 2%); color: var(--color-textcolor); font-size: .8rem; }
    button { border: 0; border-radius: .5rem; background: color-mix(in srgb, var(--color-selected) 24%, var(--color-darkbg)); color: var(--color-textcolor); font-size: .8rem; font-weight: 650; }
    input, textarea, select { outline: none; }
    input:focus, textarea:focus, select:focus, button:focus-visible { border-color: var(--color-borderc); box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-selected) 65%, transparent); }
    .lore-toolbar input { width: 100%; height: 2.15rem; padding: 0 .65rem; }
    .lore-toolbar select, .lore-toolbar button { height: 2.15rem; padding: 0 .62rem; white-space: nowrap; }
    button { cursor: pointer; }
    button:hover { background: color-mix(in srgb, var(--color-selected) 72%, var(--color-darkbg)); }
    .toolbar-action, .restore, .action-with-icon, .batch-heading button { display: inline-flex; align-items: center; justify-content: center; gap: .38rem; }
    .toolbar-action.primary { background: var(--color-selected); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-borderc) 55%, transparent); }
    .restore { background: color-mix(in srgb, var(--color-borderc) 28%, var(--color-darkbg)); }
    .lore-rows { min-height: 0; flex: 1; overflow-y: auto; padding: .6rem; }
    [data-lorebook-row] { position: relative; display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; content-visibility: auto; contain-intrinsic-size: auto 3.05rem; gap: .48rem; min-height: 3.05rem; margin-bottom: .32rem; padding: .42rem .55rem; border: 1px solid transparent; border-radius: .62rem; background: var(--lore-surface-root); cursor: default; transition: border-color 160ms ease, background-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease; }
    .lore-workspace[data-drag-enabled='true'] [data-lorebook-row] { cursor: grab; }
    .lore-workspace[data-drag-enabled='true'] [data-lorebook-row]:active { cursor: grabbing; }
    [data-lorebook-row]:hover { border-color: color-mix(in srgb, var(--color-borderc) 55%, transparent); background: color-mix(in srgb, var(--color-selected) 28%, var(--color-darkbg)); }
    [data-lorebook-row].selected { border-color: color-mix(in srgb, var(--color-borderc) 78%, transparent); background: var(--lore-selection); }
    [data-lorebook-row].active { border-color: var(--color-borderc); box-shadow: inset .22rem 0 0 var(--color-borderc), 0 0 0 1px color-mix(in srgb, var(--color-borderc) 24%, transparent); }
    [data-lorebook-row][data-folder-key]:not([data-folder-key='']) { margin-left: 2rem; }
    [data-lorebook-row][data-folder-key]:not([data-folder-key='']) { background: var(--lore-surface-child); }
    [data-lorebook-row][data-folder-key]:not([data-folder-key='']).selected { background: var(--lore-selection); }
    [data-lorebook-row][data-folder-key]:not([data-folder-key=''])::before { position: absolute; top: -.5rem; bottom: -.5rem; left: -1.05rem; width: .8rem; border-bottom: 2px solid var(--lore-hierarchy-line); border-left: 2px solid var(--lore-hierarchy-line); border-radius: 0 0 0 .45rem; content: ''; pointer-events: none; }
    [data-lorebook-row].folder { min-height: 3.3rem; margin-top: .45rem; border-color: var(--lore-hierarchy-line); background: var(--lore-surface-folder); box-shadow: inset .24rem 0 0 var(--lore-hierarchy-line); }
    [data-lorebook-row].dragging-group { border-color: var(--lore-drop-target); background: var(--lore-selection); opacity: .72; }
    [data-lorebook-row][data-drop-position='before'] { box-shadow: inset 0 .22rem 0 var(--lore-drop-target); }
    [data-lorebook-row][data-drop-position='after'] { box-shadow: inset 0 -.22rem 0 var(--lore-drop-target); }
    [data-lorebook-row][data-drop-position='inside'] { border-color: var(--lore-drop-target); background: color-mix(in srgb, var(--lore-drop-target) 12%, var(--lore-surface-folder)); box-shadow: inset 0 0 0 .16rem var(--lore-drop-target), 0 0 0 .12rem color-mix(in srgb, var(--lore-drop-target) 24%, transparent); }
    .folder-disclosure { display: grid; width: 2.15rem; height: 2.15rem; padding: 0; place-items: center; background: color-mix(in srgb, var(--color-borderc) 24%, var(--color-darkbg)); color: var(--color-borderc); }
    .row-select-hit-area { display: contents; }
    .child-glyph { color: var(--color-textcolor2); font-size: .85rem; }
    .row-main { display: grid; min-width: 0; gap: .12rem; padding: .12rem .2rem; border: 0; background: transparent; text-align: left; }
    .row-main:hover { background: transparent; }
    .row-title { display: flex; min-width: 0; align-items: center; gap: .42rem; }
    .row-title strong, .row-main small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row-title strong { font-size: .84rem; font-weight: 600; }
    .folder .row-title strong { font-size: .88rem; font-weight: 650; letter-spacing: 0; }
    .row-main small { padding-left: 1.42rem; color: var(--color-textcolor2); font-size: .69rem; font-weight: 400; }
    .row-actions { display: inline-flex; align-items: center; gap: .36rem; }
    .row-delete { display: inline-grid; width: 1.8rem; height: 1.8rem; padding: 0; place-items: center; border: 0; background: transparent; color: var(--color-danger-500, #dc2626); opacity: 0; pointer-events: none; transition: opacity 140ms ease, background-color 140ms ease; }
    [data-lorebook-row]:hover .row-delete, [data-lorebook-row]:focus-within .row-delete { opacity: 1; pointer-events: auto; }
    .row-delete:hover { background: color-mix(in srgb, var(--color-danger-500, #dc2626) 12%, transparent); }
    [data-lorebook-row].unreachable-entry .row-title strong { color: var(--color-danger-500, #dc2626); }
    [data-lorebook-row].hidden-entry .row-title strong { color: var(--color-textcolor2); opacity: .56; }
    .empty { padding: 2rem; color: var(--color-textcolor2); text-align: center; }
    .batch-editor { display: grid; align-content: start; gap: 1rem; min-height: 100%; padding: 1.2rem; background: var(--lore-surface-root); }
    .batch-heading { display: flex; align-items: center; justify-content: space-between; gap: .8rem; padding-bottom: .85rem; border-bottom: 1px solid var(--color-darkborderc); }
    .batch-heading > div { display: grid; gap: .18rem; }
    .batch-heading strong { font-size: 1rem; }
    .batch-heading button { display: inline-flex; min-height: 2.35rem; align-items: center; gap: .38rem; padding: .45rem .65rem; }
    .batch-kicker { color: var(--color-textcolor2); font-size: .7rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; }
    .batch-notice, .batch-drag-help { margin: 0; padding: .7rem .8rem; border-left: .22rem solid var(--lore-hierarchy-line); border-radius: .35rem; background: var(--lore-surface-child); color: var(--color-textcolor2); font-size: .76rem; line-height: 1.5; }
    .batch-toggle-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .55rem; }
    .batch-toggle { display: flex; min-height: 2.75rem; align-items: center; justify-content: space-between; gap: .8rem; padding: .55rem .7rem; border: 1px solid var(--color-darkborderc); background: var(--lore-surface-child); text-align: left; }
    .toggle-mark { position: relative; width: 2rem; height: 1.05rem; flex: 0 0 auto; border: 1px solid var(--color-darkborderc); border-radius: 1rem; background: color-mix(in srgb, var(--color-textcolor2) 24%, transparent); }
    .toggle-mark::after { position: absolute; top: .12rem; left: .14rem; width: .7rem; height: .7rem; border-radius: 50%; background: var(--color-textcolor2); content: ''; transition: transform 160ms ease, background-color 160ms ease; }
    .batch-toggle[aria-checked='true'] .toggle-mark { background: var(--lore-selection); }
    .batch-toggle[aria-checked='true'] .toggle-mark::after { background: var(--color-textcolor); transform: translateX(.86rem); }
    .batch-toggle.mixed .toggle-mark::after { width: .95rem; border-radius: .5rem; background: var(--lore-drop-target); transform: translateX(.38rem); }
    .batch-key-field { display: grid; gap: .38rem; color: var(--color-textcolor2); font-size: .74rem; font-weight: 650; }
    .batch-key-field input { min-height: 2.65rem; padding: .5rem .65rem; }
    .batch-key-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .45rem; }
    .batch-key-actions button { min-height: 2.4rem; padding: .45rem; }
    .lore-splitter { position: absolute; top: 0; bottom: 0; left: calc(var(--lore-effective-list-width) - .25rem); z-index: 5; width: .5rem; border: 0; border-radius: 0; background: transparent; cursor: col-resize; touch-action: none; }
    .lore-splitter:hover, .lore-splitter:focus-visible, .lore-splitter:global([data-resizing]) { background: color-mix(in srgb, var(--color-borderc) 45%, transparent); box-shadow: none; }
    .lore-editor-pane { display: flex; grid-row: 2; grid-column: 2; flex-direction: column; background: var(--color-darkbg); }
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
    .content-field { display: grid; min-height: 0; flex: 1; gap: .35rem; grid-template-rows: auto minmax(0, 1fr); }
    .content-heading { display:flex; align-items:center; justify-content:space-between; gap:.5rem; color:var(--color-textcolor2); font-size:.74rem; font-weight:650; }
    .content-heading button { padding:.25rem .55rem; border:1px solid var(--color-darkborderc); border-radius:.35rem; font-size:.72rem; }
    .lore-content {
        min-height: 18rem;
        height: 100%;
        resize: none;
        font-family: inherit;
        font-size: .86rem;
        font-weight: 400;
        line-height: 1.6;
    }
    .lore-state-rail { display: flex; min-height: 0; flex-direction: column; gap: .5rem; padding: .9rem; border-left: 1px solid var(--color-darkborderc); background: color-mix(in srgb, var(--color-selected) 15%, transparent); }
    .lore-state-rail label { display: flex; align-items: center; gap: .48rem; font-size: .77rem; }
    .lore-state-rail button, .lore-state-rail select { width: 100%; min-height: 2.15rem; padding: .42rem; }
    .entry-actions { margin-top: .3rem; padding-top: .7rem; border-top: 1px solid var(--color-darkborderc); }
    .entry-actions summary { padding: .42rem; border-radius: .45rem; color: var(--color-textcolor2); cursor: pointer; font-size: .76rem; font-weight: 600; }
    .entry-actions summary:hover { background: var(--lore-surface-child); color: var(--color-textcolor); }
    .entry-action-list { display: grid; gap: .45rem; padding-top: .55rem; }
    .activation-control { display: grid !important; align-items: stretch !important; gap: .24rem !important; }
    .activation-control input { width: 100%; padding: .35rem; }
    .danger { background: color-mix(in srgb, var(--color-danger-600) 52%, var(--color-darkbg)); color: var(--color-danger-50); }
    .danger:hover { background: color-mix(in srgb, var(--color-danger-600) 76%, var(--color-darkbg)); }
    .editor-empty, .folder-editor, .child-link-editor { display: grid; height: 100%; place-content: center; gap: .35rem; padding: 2rem; color: var(--color-textcolor2); text-align: center; }
    .editor-empty span { font-size: 2rem; opacity: .35; }
    .editor-empty strong, .child-link-editor strong { color: var(--color-textcolor); font-weight: 600; }
    .editor-empty p { margin: 0; font-size: .8rem; }
    .folder-editor-card { display: grid; width: min(30rem, 80vw); gap: .85rem; padding: 1.3rem; border: 1px solid color-mix(in srgb, var(--color-borderc) 40%, var(--color-darkborderc)); border-radius: .8rem; background: color-mix(in srgb, var(--color-darkbg) 86%, var(--color-selected) 14%); box-shadow: inset .25rem 0 0 var(--color-borderc); text-align: left; }
    .folder-editor-card label, .child-link-editor label { display: grid; gap: .32rem; font-size: .75rem; font-weight: 650; }
    .folder-editor-card input, .child-link-editor input { padding: .5rem; }
    .folder-kicker { color: var(--color-textcolor2); font-size: .69rem; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
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
        .batch-editor { min-height: auto; overflow-y: auto; padding: .9rem .8rem calc(.9rem + env(safe-area-inset-bottom)); }
        .batch-toggle-grid, .batch-key-actions { grid-template-columns: 1fr; }
        button, input, select { min-height: 3rem; touch-action: manipulation; }
        .folder-disclosure, .row-select-hit-area { min-width: 3rem; min-height: 3rem; }
        .row-select-hit-area { display: grid; min-width: 3rem; min-height: 3rem; place-items: center; }
        [data-lorebook-row] { min-height: 3.35rem; padding: .46rem .35rem; }
        [data-lorebook-row][data-folder-key]:not([data-folder-key='']) { margin-left: 1.4rem; }
        .toolbar-action { flex: 1 1 auto; }
        [data-lorebook-select] { width: 1rem; min-width: 1rem; height: 1rem; min-height: 1rem; margin: 0; }
        textarea { touch-action: manipulation; }
    }
</style>
