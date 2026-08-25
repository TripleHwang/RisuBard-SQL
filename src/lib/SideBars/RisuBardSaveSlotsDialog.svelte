<script lang="ts">
    import { ArrowDownIcon, ArrowUpIcon, Clock3Icon, LoaderCircleIcon, PencilIcon, Trash2Icon } from '@lucide/svelte'
    import loadIcon from 'src/assets/solar-bold/undo-left-square-bold.svg'
    import { alertConfirm, alertInput } from 'src/ts/alert'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import {
        deleteMemorySaveSlot,
        listMemorySaveSlots,
        previewMemorySaveSlot,
        renameMemorySaveSlot,
        shouldConfirmMemorySaveLoad,
        type MemorySavePreviewMessage,
        type MemorySaveSlotSummary,
    } from 'src/ts/risubard/memorySaveSlots'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import SolarAssetIcon from '../UI/Icons/SolarAssetIcon.svelte'

    interface Props {
        open: boolean
        characterId: string
        currentChatId: string
        currentLatestMessageId?: string
        onOpenChange(open: boolean): void
        onLoad(saveId: string): Promise<void>
    }

    let {
        open,
        characterId,
        currentChatId,
        currentLatestMessageId,
        onOpenChange,
        onLoad,
    }: Props = $props()
    let slots = $state<MemorySaveSlotSummary[]>([])
    let selectedId = $state('')
    let sortAscending = $state(true)
    let loading = $state(false)
    let loadingId = $state('')
    let previewLoadingId = $state('')
    let previewCache = $state<Record<string, MemorySavePreviewMessage[]>>({})
    let error = $state('')
    let requestSequence = 0
    let workspaceElement = $state<HTMLElement | null>(null)
    let previewShare = $state(45)
    const workspaceStyle = $derived(
        `grid-template-rows:minmax(8rem,${100 - previewShare}fr) 0.75rem minmax(8rem,${previewShare}fr);`
    )

    const sortedSlots = $derived.by(() => [...slots].sort((left, right) => {
        const comparison = left.createdAt.localeCompare(right.createdAt)
            || left.saveId.localeCompare(right.saveId)
        return sortAscending ? comparison : -comparison
    }))
    const selectedSlot = $derived(slots.find((slot) => slot.saveId === selectedId))
    const selectedPreview = $derived(previewCache[selectedId] ?? [])

    async function ensurePreview(saveId: string): Promise<void> {
        if (!saveId || previewCache[saveId] || previewLoadingId === saveId) return
        previewLoadingId = saveId
        try {
            const messages = await previewMemorySaveSlot({
                characterId,
                saveId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            previewCache[saveId] = messages
            previewCache = { ...previewCache }
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            if (previewLoadingId === saveId) previewLoadingId = ''
        }
    }

    function selectSlot(saveId: string): void {
        selectedId = saveId
        void ensurePreview(saveId)
    }

    async function refresh(): Promise<void> {
        const sequence = ++requestSequence
        loading = true
        error = ''
        try {
            const next = await listMemorySaveSlots({
                characterId,
                sourceChatId: currentChatId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            if (sequence !== requestSequence) return
            slots = next
            if (!next.some((slot) => slot.saveId === selectedId)) {
                selectedId = [...next].sort((left, right) =>
                    left.createdAt.localeCompare(right.createdAt)
                    || left.saveId.localeCompare(right.saveId)
                )[0]?.saveId ?? ''
            }
            if (selectedId) void ensurePreview(selectedId)
        }
        catch (cause) {
            if (sequence === requestSequence) {
                error = cause instanceof Error ? cause.message : String(cause)
            }
        }
        finally {
            if (sequence === requestSequence) loading = false
        }
    }

    async function load(saveId: string): Promise<void> {
        if (loadingId) return
        loadingId = saveId
        error = ''
        try {
            if (shouldConfirmMemorySaveLoad(currentLatestMessageId, slots)
                && !await alertConfirm(
                    '저장하지 않은 채팅은 사라집니다. 불러올까요?'
                )) return
            await onLoad(saveId)
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            loadingId = ''
        }
    }

    async function renameSelected(): Promise<void> {
        if (!selectedSlot) return
        const name = await alertInput('저장된 파일 이름 변경', [], selectedSlot.sourceChatName)
        if (!name?.trim()) return
        try {
            const renamed = await renameMemorySaveSlot({
                characterId,
                saveId: selectedSlot.saveId,
                name,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            slots = slots.map((slot) => slot.saveId === renamed.saveId ? renamed : slot)
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    async function deleteSelected(): Promise<void> {
        if (!selectedSlot) return
        if (!await alertConfirm(`저장된 파일을 삭제할까요?\n${selectedSlot.sourceChatName}`)) return
        try {
            const deletedId = selectedSlot.saveId
            await deleteMemorySaveSlot({
                characterId,
                saveId: deletedId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            slots = slots.filter((slot) => slot.saveId !== deletedId)
            delete previewCache[deletedId]
            previewCache = { ...previewCache }
            selectedId = [...slots].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt)
                || left.saveId.localeCompare(right.saveId)
            )[0]?.saveId ?? ''
            if (selectedId) void ensurePreview(selectedId)
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    function savedAt(value: string): string {
        return new Date(value).toLocaleString()
    }

    function setPreviewShare(value: number): void {
        previewShare = Math.min(70, Math.max(20, Math.round(value)))
    }

    function startPreviewResize(event: PointerEvent): void {
        if (!workspaceElement || event.button !== 0) return
        event.preventDefault()
        const bounds = workspaceElement.getBoundingClientRect()
        const update = (clientY: number) => {
            if (bounds.height <= 0) return
            setPreviewShare((bounds.bottom - clientY) / bounds.height * 100)
        }
        const move = (next: PointerEvent) => {
            update(next.clientY)
        }
        const end = () => {
            document.removeEventListener('pointermove', move)
            document.removeEventListener('pointerup', end)
            document.removeEventListener('pointercancel', end)
        }
        update(event.clientY)
        document.addEventListener('pointermove', move)
        document.addEventListener('pointerup', end)
        document.addEventListener('pointercancel', end)
    }

    function resizePreviewByKeyboard(event: KeyboardEvent): void {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        setPreviewShare(previewShare + (event.key === 'ArrowUp' ? 5 : -5))
    }

    $effect(() => {
        if (open && characterId && currentChatId) {
            void refresh()
        }
    })
</script>

<ShDialog
    {open}
    onOpenChange={onOpenChange}
    size="xl"
    tier="base"
    contentClass="save-slot-dialog"
    bodyClass="save-slot-dialog__body"
>
    {#snippet title()}채팅 불러오기{/snippet}

    <div class="save-ledger">
        <div class="save-ledger__head">
            <strong class="save-section-title">저장된 파일</strong>
            <div data-save-file-toolbar class="save-ledger__toolbar">
                <ShButton data-save-file-rename variant="ghost" size="icon-sm" aria-label="선택한 파일 이름 변경" title="선택한 파일 이름 변경" disabled={!selectedSlot} onclick={() => void renameSelected()}>
                    <PencilIcon size={16} />
                </ShButton>
                <ShButton data-save-file-delete variant="destructive" size="icon-sm" aria-label="선택한 파일 삭제" title="선택한 파일 삭제" disabled={!selectedSlot} onclick={() => void deleteSelected()}>
                    <Trash2Icon size={16} />
                </ShButton>
                <span class="save-ledger__divider"></span>
                <ShButton data-save-file-sort variant="ghost" size="icon-sm" aria-label={sortAscending ? '새 파일을 위로 정렬' : '오래된 파일을 위로 정렬'} title={sortAscending ? '현재: 오래된 파일부터' : '현재: 새 파일부터'} onclick={() => { sortAscending = !sortAscending }}>
                    {#if sortAscending}<ArrowUpIcon size={16} />{:else}<ArrowDownIcon size={16} />{/if}
                </ShButton>
            </div>
        </div>

        {#if error}<p class="save-ledger__error">{error}</p>{/if}

        {#if loading && slots.length === 0}
            <div class="save-ledger__empty"><LoaderCircleIcon size={20} class="animate-spin" />저장된 파일을 읽는 중…</div>
        {:else if slots.length === 0}
            <div class="save-ledger__empty">아직 저장된 채팅이 없습니다.</div>
        {:else}
            <div
                data-save-file-workspace
                class="save-workspace"
                style={workspaceStyle}
                bind:this={workspaceElement}
            >
                <ol data-save-file-grid class="save-ledger__list">
                    {#each sortedSlots as slot, index (slot.saveId)}
                        <li class:save-slot--selected={slot.saveId === selectedId} class="save-slot">
                            <button type="button" class="save-slot__select risu-button-lift" aria-pressed={slot.saveId === selectedId} onclick={() => selectSlot(slot.saveId)}>
                                <span class="save-slot__index">{String(index + 1).padStart(2, '0')}</span>
                                <span class="save-slot__body">
                                    <span class="save-slot__title-row">
                                        <strong>{slot.sourceChatName}</strong>
                                        <span>[턴 {slot.turnCount}]</span>
                                    </span>
                                    <span class="save-slot__meta">
                                        <span><Clock3Icon size={12} />{savedAt(slot.createdAt)}</span>
                                    </span>
                                </span>
                            </button>
                            <ShButton data-save-file-load className="save-slot__load size-14" size="icon-sm" aria-label={`${slot.sourceChatName} 불러오기`} title="선택한 저장 파일 불러오기" disabled={Boolean(loadingId)} onclick={(event) => { event.stopPropagation(); void load(slot.saveId) }}>
                                {#if loadingId === slot.saveId}
                                    <LoaderCircleIcon size={32} class="animate-spin" />
                                {:else}
                                    <SolarAssetIcon src={loadIcon} name="undo-left-square-bold" size={48} />
                                {/if}
                            </ShButton>
                        </li>
                    {/each}
                </ol>

                <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
                <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
                <div
                    data-preview-resize-handle
                    class="preview-resize-handle"
                    role="separator"
                    tabindex="0"
                    aria-label="저장 파일 목록과 프리뷰 영역 크기 조절"
                    aria-orientation="horizontal"
                    aria-valuemin="20"
                    aria-valuemax="70"
                    aria-valuenow={previewShare}
                    onpointerdown={startPreviewResize}
                    onkeydown={resizePreviewByKeyboard}
                ><span></span></div>

                <aside data-save-file-preview class="save-preview">
                    <div class="save-preview__head">
                        {#if selectedSlot}
                            <strong class="save-section-title">'{selectedSlot.sourceChatName}'의 최근 대화</strong>
                        {/if}
                    </div>
                    <div class="save-preview__body">
                        {#if previewLoadingId === selectedId}
                            <div class="save-preview__empty"><LoaderCircleIcon size={18} class="animate-spin" />프리뷰 읽는 중…</div>
                        {:else if selectedPreview.length === 0}
                            <div class="save-preview__empty">표시할 최근 대화가 없습니다.</div>
                        {:else}
                            {#each selectedPreview as message}
                                <article class:save-preview__message--user={message.role === 'user'} class="save-preview__message">
                                    <span>{message.role === 'user' ? 'USER' : 'CHARACTER'}</span>
                                    <p>{message.data}</p>
                                </article>
                            {/each}
                        {/if}
                    </div>
                </aside>
            </div>
        {/if}
    </div>
</ShDialog>

<style>
    :global(.save-slot-dialog) {
        min-width: min(40rem, calc(100vw - 2rem));
        height: 70vh;
        overflow: hidden;
        background: linear-gradient(145deg, color-mix(in srgb, var(--color-darkbg) 94%, var(--color-selected) 6%), var(--color-darkbg));
    }
    :global(.save-slot-dialog__body) { flex: 1; min-height: 0; }
    .save-ledger {
        display: flex;
        height: 100%;
        min-height: 0;
        flex-direction: column;
        gap: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid var(--color-darkborderc);
    }
    .save-ledger__head, .save-ledger__toolbar, .save-slot__meta, .save-preview__head {
        display: flex;
        align-items: center;
    }
    .save-ledger__head { justify-content: space-between; gap: 0.75rem; }
    .save-section-title { color: #fff; font-size: 0.75rem; letter-spacing: 0.08em; }
    .save-ledger__toolbar { gap: 0.2rem; margin-left: auto; }
    .save-ledger__divider { width: 1px; height: 1.1rem; margin: 0 0.2rem; background: var(--color-darkborderc); }
    .save-workspace {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        flex: 1;
        min-height: 0;
    }
    .save-ledger__list {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        align-content: start;
        gap: 0.55rem;
        height: 100%;
        min-height: 0;
        margin: 0;
        padding: 0 0.35rem 0 0;
        overflow-y: scroll;
        list-style: none;
        scrollbar-gutter: stable;
        scrollbar-color: var(--color-borderc) transparent;
        scrollbar-width: thin;
    }
    .preview-resize-handle { display: grid; width: 100%; height: 0.75rem; place-items: center; padding: 0; border: 0; background: transparent; cursor: row-resize; touch-action: none; }
    .preview-resize-handle span { width: 4rem; height: 0.2rem; border-radius: 999px; background: var(--color-darkborderc); transition: width 120ms ease, background 120ms ease; }
    .preview-resize-handle:hover span, .preview-resize-handle:focus-visible span { width: 5.5rem; background: var(--color-borderc); }
    .preview-resize-handle:focus-visible { outline: 2px solid color-mix(in srgb, var(--color-borderc) 70%, transparent); outline-offset: -2px; }
    .save-slot {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        min-width: 0;
        min-height: 4.25rem;
        padding: 0.35rem 0.35rem 0.35rem 0;
        border: 1px solid var(--color-darkborderc);
        border-radius: 0.55rem;
        background: color-mix(in srgb, var(--color-darkbg) 82%, var(--color-selected) 18%);
        transition: border-color 140ms ease, box-shadow 140ms ease;
    }
    .save-slot:hover, .save-slot:focus-within { border-color: var(--color-borderc); box-shadow: 0 0.45rem 1.25rem rgb(0 0 0 / 0.18); }
    .save-slot--selected { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 28%, var(--color-darkbg)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 45%, transparent); }
    .save-slot__select {
        display: grid;
        grid-template-columns: 2.25rem minmax(0, 1fr);
        align-self: stretch;
        min-width: 0;
        text-align: left;
    }
    .save-slot__index { display: grid; place-items: center; border-right: 1px solid var(--color-darkborderc); color: var(--color-textcolor2); font: 600 0.68rem ui-monospace, monospace; letter-spacing: 0.06em; }
    .save-slot__body { min-width: 0; padding: 0.55rem 0.65rem; }
    .save-slot__title-row { display: inline-flex; max-width: 100%; align-items: center; gap: 0.35rem; padding: 0.22rem 0.48rem; border-radius: 999px; color: #fff; background: color-mix(in srgb, var(--color-primary) 68%, var(--color-selected)); }
    .save-slot__title-row strong { overflow: hidden; min-width: 0; font-size: 0.8rem; text-overflow: ellipsis; white-space: nowrap; }
    .save-slot__title-row > span { flex: none; font-size: 0.68rem; font-weight: 700; }
    .save-slot__meta { flex-wrap: wrap; gap: 0.2rem 0.55rem; margin-top: 0.28rem; color: var(--color-textcolor2); font-size: 0.65rem; }
    .save-slot__meta span { display: inline-flex; align-items: center; gap: 0.2rem; }
    :global(.save-slot__load) { width: 56px; height: 56px; }
    .save-preview {
        display: flex;
        height: auto;
        min-width: 0;
        min-height: 0;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid var(--color-darkborderc);
        border-radius: 0.55rem;
        background: color-mix(in srgb, var(--color-darkbg) 90%, var(--color-selected) 10%);
    }
    .save-preview__head { justify-content: flex-start; gap: 0.75rem; padding: 0.6rem 0.75rem; border-bottom: 1px solid var(--color-darkborderc); }
    .save-preview__head strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .save-preview__body { display: flex; flex: 1; flex-direction: column; gap: 0.45rem; padding: 0.65rem; overflow-y: auto; scrollbar-color: var(--color-borderc) transparent; scrollbar-width: thin; }
    .save-preview__message { align-self: flex-start; max-width: 94%; padding: 0.5rem 0.58rem; border: 1px solid var(--color-darkborderc); border-radius: 0.48rem; background: var(--color-darkbg); }
    .save-preview__message--user { align-self: flex-end; background: color-mix(in srgb, var(--color-selected) 45%, var(--color-darkbg)); }
    .save-preview__message > span { color: var(--color-textcolor2); font-size: 0.56rem; letter-spacing: 0.08em; }
    .save-preview__message p { margin: 0.2rem 0 0; color: var(--color-textcolor); font-size: 0.72rem; line-height: 1.45; white-space: pre-wrap; overflow-wrap: anywhere; }
    .save-preview__empty, .save-ledger__empty { display: flex; min-height: 8rem; align-items: center; justify-content: center; gap: 0.45rem; color: var(--color-textcolor2); font-size: 0.78rem; }
    .save-ledger__empty { border: 1px dashed var(--color-darkborderc); border-radius: 0.5rem; }
    .save-ledger__error { margin: 0; color: #f87171; font-size: 0.76rem; }

    @media (max-width: 767px) {
        :global(.save-slot-dialog) { min-width: calc(100vw - 2rem); }
        .save-ledger__list { grid-template-columns: minmax(0, 1fr); }
    }
</style>
