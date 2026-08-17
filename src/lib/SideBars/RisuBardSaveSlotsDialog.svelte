<script lang="ts">
    import { Clock3Icon, LoaderCircleIcon, RotateCcwIcon } from '@lucide/svelte'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import {
        listMemorySaveSlots,
        type MemorySaveSlotSummary,
    } from 'src/ts/risubard/memorySaveSlots'

    interface Props {
        open: boolean
        characterId: string
        onOpenChange(open: boolean): void
        onLoad(saveId: string): Promise<void>
    }

    let { open, characterId, onOpenChange, onLoad }: Props = $props()
    let slots = $state<MemorySaveSlotSummary[]>([])
    let loading = $state(false)
    let loadingId = $state('')
    let error = $state('')
    let requestSequence = 0

    async function refresh() {
        const sequence = ++requestSequence
        loading = true
        error = ''
        try {
            const next = await listMemorySaveSlots({
                characterId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            if (sequence === requestSequence) slots = next
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

    async function load(saveId: string) {
        if (loadingId) return
        loadingId = saveId
        error = ''
        try {
            await onLoad(saveId)
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            loadingId = ''
        }
    }

    function savedAt(value: string): string {
        return new Date(value).toLocaleString()
    }

    $effect(() => {
        if (open && characterId) void refresh()
    })
</script>

<ShDialog
    {open}
    onOpenChange={onOpenChange}
    size="lg"
    tier="base"
    contentClass="save-slot-dialog"
>
    {#snippet title()}채팅 불러오기{/snippet}
    {#snippet description()}
        저장 당시의 대화, 변수와 Memory Wiki를 새 채팅으로 복제합니다.
    {/snippet}

    <div class="save-ledger">
        <div class="save-ledger__head">
            <span>세이브 슬롯</span>
            <button
                type="button"
                class="save-ledger__refresh"
                aria-label="세이브 목록 새로고침"
                disabled={loading}
                onclick={() => void refresh()}
            >
                <RotateCcwIcon size={15} class={loading ? 'animate-spin' : ''} />
            </button>
        </div>

        {#if error}
            <p class="save-ledger__error">{error}</p>
        {/if}

        {#if loading && slots.length === 0}
            <div class="save-ledger__empty">
                <LoaderCircleIcon size={20} class="animate-spin" />
                세이브 목록을 읽는 중…
            </div>
        {:else if slots.length === 0}
            <div class="save-ledger__empty">아직 저장된 채팅이 없습니다.</div>
        {:else}
            <ol class="save-ledger__list">
                {#each slots as slot, index (slot.saveId)}
                    {@const tooltipId = `save-event-${slot.saveId}`}
                    <li class="save-slot">
                        <div class="save-slot__index">
                            {String(slots.length - index).padStart(2, '0')}
                        </div>
                        <div class="save-slot__body">
                            <strong>{slot.sourceChatName}</strong>
                            <div class="save-slot__meta">
                                <span><Clock3Icon size={13} />{savedAt(slot.createdAt)}</span>
                                <span>{slot.turnCount}턴</span>
                            </div>
                        </div>
                        <button
                            type="button"
                            class="save-slot__load"
                            aria-label="이 세이브 불러오기"
                            aria-describedby={slot.latestEvent ? tooltipId : undefined}
                            disabled={Boolean(loadingId)}
                            onclick={() => void load(slot.saveId)}
                        >
                            {#if loadingId === slot.saveId}
                                <LoaderCircleIcon size={15} class="animate-spin" />
                            {:else}
                                불러오기
                            {/if}
                        </button>
                        {#if slot.latestEvent}
                            <div
                                id={tooltipId}
                                role="tooltip"
                                class="save-slot__tooltip"
                            >
                                <span>최신 사건</span>
                                <strong>{slot.latestEvent.title}</strong>
                                <p>{slot.latestEvent.excerpt}</p>
                            </div>
                        {/if}
                    </li>
                {/each}
            </ol>
        {/if}
    </div>
</ShDialog>

<style>
    :global(.save-slot-dialog) {
        background:
            linear-gradient(145deg, color-mix(in srgb, var(--color-darkbg) 92%, #8b6a34 8%), var(--color-darkbg));
    }
    .save-ledger {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }
    .save-ledger__head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        color: var(--color-textcolor2);
        font-size: 0.72rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
    }
    .save-ledger__refresh {
        padding: 0.3rem;
        border-radius: 0.35rem;
        color: var(--color-textcolor2);
        cursor: pointer;
    }
    .save-ledger__refresh:hover { color: var(--color-textcolor); }
    .save-ledger__list {
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .save-slot {
        position: relative;
        display: grid;
        grid-template-columns: 2.6rem minmax(0, 1fr) auto;
        align-items: center;
        min-height: 4.5rem;
        overflow: visible;
        border: 1px solid var(--color-darkborderc);
        border-radius: 0.55rem;
        background: color-mix(in srgb, var(--color-darkbg) 82%, var(--color-selected) 18%);
        transition: border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease;
    }
    .save-slot:hover, .save-slot:focus-within {
        z-index: 2;
        border-color: var(--color-borderc);
        transform: translateY(-1px);
        box-shadow: 0 0.6rem 1.6rem rgb(0 0 0 / 0.2);
        outline: none;
    }
    .save-slot__index {
        align-self: stretch;
        display: grid;
        place-items: center;
        border-right: 1px solid var(--color-darkborderc);
        color: var(--color-textcolor2);
        font: 600 0.72rem ui-monospace, monospace;
        letter-spacing: 0.08em;
    }
    .save-slot__body { min-width: 0; padding: 0.7rem 0.85rem; }
    .save-slot__body strong {
        display: block;
        overflow: hidden;
        color: var(--color-textcolor);
        font-size: 0.9rem;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .save-slot__meta {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem 0.75rem;
        margin-top: 0.3rem;
        color: var(--color-textcolor2);
        font-size: 0.72rem;
    }
    .save-slot__meta span { display: inline-flex; align-items: center; gap: 0.25rem; }
    .save-slot__load {
        margin-right: 0.7rem;
        padding: 0.4rem 0.65rem;
        border: 1px solid var(--color-borderc);
        border-radius: 0.4rem;
        color: var(--color-textcolor);
        font-size: 0.76rem;
        cursor: pointer;
        transition: background 120ms ease;
    }
    .save-slot__load:hover { background: var(--color-selected); }
    .save-slot__load:disabled { cursor: wait; opacity: 0.55; }
    .save-slot__tooltip {
        pointer-events: none;
        position: absolute;
        right: 0.6rem;
        bottom: calc(100% + 0.45rem);
        width: min(21rem, calc(100vw - 4rem));
        padding: 0.7rem 0.8rem;
        border: 1px solid var(--color-borderc);
        border-radius: 0.45rem;
        background: var(--color-darkbg);
        box-shadow: 0 0.75rem 2rem rgb(0 0 0 / 0.35);
        opacity: 0;
        transform: translateY(0.25rem);
        transition: opacity 120ms ease, transform 120ms ease;
    }
    .save-slot:hover .save-slot__tooltip,
    .save-slot:focus-within .save-slot__tooltip {
        opacity: 1;
        transform: translateY(0);
    }
    .save-slot__tooltip span {
        display: block;
        color: var(--color-textcolor2);
        font-size: 0.65rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }
    .save-slot__tooltip strong { display: block; margin-top: 0.2rem; font-size: 0.82rem; }
    .save-slot__tooltip p { margin: 0.3rem 0 0; color: var(--color-textcolor2); font-size: 0.75rem; line-height: 1.45; }
    .save-ledger__empty {
        display: flex;
        min-height: 8rem;
        align-items: center;
        justify-content: center;
        gap: 0.45rem;
        border: 1px dashed var(--color-darkborderc);
        border-radius: 0.5rem;
        color: var(--color-textcolor2);
        font-size: 0.82rem;
    }
    .save-ledger__error { margin: 0; color: #f87171; font-size: 0.78rem; }
</style>
