<script lang="ts">
    import { LoaderCircleIcon, XIcon } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import SolarAssetIcon from 'src/lib/UI/Icons/SolarAssetIcon.svelte'
    import feedIcon from 'src/assets/solar-bold/feed-bold.svg'
    import loadIcon from 'src/assets/solar-bold/undo-left-square-bold.svg'
    import { language } from 'src/lang'
    import { alertConfirm } from 'src/ts/alert'
    import { requestImmediateSave } from 'src/ts/globalApi.svelte'
    import {
        FAB_DRAG_THRESHOLD,
        normalizeFabPlacement,
        placementFromClientPoint,
        resolveFabPosition,
        type FloatingActionButtonSize,
    } from 'src/ts/plugins/floatingActionButtonLayout'
    import {
        anchorSaveLoadShortcut,
        normalizeSaveLoadShortcutPlacement,
        resolveSaveLoadShortcutPosition,
        type SaveLoadShortcutBounds,
        type SaveLoadShortcutPlacement,
    } from 'src/ts/risubard/saveLoadShortcutLayout'
    import { DBState } from 'src/ts/stores.svelte'

    interface Props {
        anchorElement?: HTMLElement | null
        saving?: boolean
        onSave: () => void | Promise<void>
        onLoad: () => void
    }

    interface DragState {
        pointerId: number
        startClientX: number
        startClientY: number
        startLeft: number
        startTop: number
        moved: boolean
    }

    let {
        anchorElement = null,
        saving = false,
        onSave,
        onLoad,
    }: Props = $props()
    let dock = $state<HTMLDivElement | null>(null)
    let viewport = $state({ width: 1, height: 1 })
    let dockSize = $state<FloatingActionButtonSize>({ width: 154, height: 68 })
    let anchorBounds = $state<SaveLoadShortcutBounds>({
        left: 0,
        top: 1,
        right: 1,
        bottom: 1,
    })
    let transientPlacement = $state<SaveLoadShortcutPlacement | null>(null)
    let drag = $state<DragState | null>(null)
    let suppressClick = false
    let legacyPlacementMigrated = false

    let position = $derived.by(() => {
        const anchored = transientPlacement
            ?? normalizeSaveLoadShortcutPlacement(
                DBState.db.risuBardSaveLoadShortcutPlacement
            )
        if (anchored) {
            return resolveSaveLoadShortcutPosition(
                anchored,
                anchorBounds,
                viewport,
                dockSize,
            )
        }
        const legacy = normalizeFabPlacement(
            DBState.db.risuBardSaveLoadShortcutPlacement
        )
        if (legacy) {
            return resolveFabPosition(legacy, 0, viewport, dockSize)
        }
        return resolveSaveLoadShortcutPosition(
            anchorSaveLoadShortcut({
                left: anchorBounds.left + dockSize.width / 2 + 16,
                top: anchorBounds.top - dockSize.height / 2 - 16,
            }, anchorBounds),
            anchorBounds,
            viewport,
            dockSize,
        )
    })

    function measure() {
        if (!dock) return
        const parent = dock.offsetParent as HTMLElement | null
        if (!parent) return
        const parentBounds = parent.getBoundingClientRect()
        const referenceBounds = anchorElement?.getBoundingClientRect()
            ?? parentBounds
        viewport = {
            width: Math.max(1, parent.clientWidth),
            height: Math.max(1, parent.clientHeight),
        }
        anchorBounds = {
            left: referenceBounds.left - parentBounds.left,
            top: referenceBounds.top - parentBounds.top,
            right: referenceBounds.right - parentBounds.left,
            bottom: referenceBounds.bottom - parentBounds.top,
        }
        dockSize = {
            width: dock.offsetWidth || dockSize.width,
            height: dock.offsetHeight || dockSize.height,
        }
        if (!legacyPlacementMigrated) {
            legacyPlacementMigrated = true
            const legacy = normalizeFabPlacement(
                DBState.db.risuBardSaveLoadShortcutPlacement
            )
            if (legacy) {
                DBState.db.risuBardSaveLoadShortcutPlacement =
                    anchorSaveLoadShortcut(
                        resolveFabPosition(legacy, 0, viewport, dockSize),
                        anchorBounds,
                    )
                void requestImmediateSave()
            }
        }
    }

    function beginDrag(event: PointerEvent) {
        if (event.button !== 0 || !dock) return
        (event.target as HTMLElement).setPointerCapture?.(event.pointerId)
        drag = {
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startLeft: position.left,
            startTop: position.top,
            moved: false,
        }
    }

    function moveDrag(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId || !dock) return
        const deltaX = event.clientX - drag.startClientX
        const deltaY = event.clientY - drag.startClientY
        if (!drag.moved && Math.hypot(deltaX, deltaY) < FAB_DRAG_THRESHOLD) return
        event.preventDefault()
        drag.moved = true
        const clamped = placementFromClientPoint(
            drag.startLeft + deltaX,
            drag.startTop + deltaY,
            viewport,
            dockSize,
        )
        transientPlacement = anchorSaveLoadShortcut({
            left: clamped.xRatio * viewport.width,
            top: clamped.yRatio * viewport.height,
        }, anchorBounds)
    }

    function endDrag(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return
        if (drag.moved && transientPlacement) {
            DBState.db.risuBardSaveLoadShortcutPlacement = transientPlacement
            void requestImmediateSave()
            suppressClick = true
            setTimeout(() => { suppressClick = false }, 0)
        }
        drag = null
    }

    function cancelDrag(event: PointerEvent) {
        if (!drag || event.pointerId !== drag.pointerId) return
        transientPlacement = null
        drag = null
    }

    function activate(event: MouseEvent, action: () => void | Promise<void>) {
        if (suppressClick) {
            suppressClick = false
            event.preventDefault()
            event.stopPropagation()
            return
        }
        void action()
    }

    async function hideShortcuts() {
        if (!await alertConfirm(language.risuBardSaveLoadShortcutHideConfirm)) return
        DBState.db.showRisuBardSaveLoadShortcuts = false
        await requestImmediateSave()
    }

    onMount(() => {
        measure()
        const parent = dock?.offsetParent
        const observer = new ResizeObserver(measure)
        if (parent instanceof Element) observer.observe(parent)
        if (anchorElement) observer.observe(anchorElement)
        if (dock) observer.observe(dock)
        return () => observer.disconnect()
    })
</script>

<div
    bind:this={dock}
    class="save-load-shortcuts"
    class:dragging={drag?.moved}
    data-chat-file-shortcuts
    role="group"
    aria-label={language.risuBardShowSaveLoadShortcuts}
    style:left={`${position.left}px`}
    style:top={`${position.top}px`}
    onpointerdown={beginDrag}
    onpointermove={moveDrag}
    onpointerup={endDrag}
    onpointercancel={cancelDrag}
>
    <div class="shortcut-action">
        <span class="shortcut-label">save</span>
        <button
            type="button"
            class="risu-button-lift shortcut-button"
            data-shortcut-save-chat
            disabled={saving}
            aria-label={language.saveChatFileAction}
            title={language.saveChatFileAction}
            onclick={(event) => activate(event, onSave)}
        >
            {#if saving}
                <LoaderCircleIcon size={21} class="animate-spin" />
            {:else}
                <SolarAssetIcon src={feedIcon} name="feed-bold" size={23} />
            {/if}
        </button>
    </div>
    <div class="shortcut-action">
        <span class="shortcut-label">load</span>
        <button
            type="button"
            class="risu-button-lift shortcut-button"
            data-shortcut-load-chat
            aria-label={language.loadChatFileAction}
            title={language.loadChatFileAction}
            onclick={(event) => activate(event, onLoad)}
        >
            <SolarAssetIcon src={loadIcon} name="undo-left-square-bold" size={23} />
        </button>
    </div>
    <button
        type="button"
        class="shortcut-close"
        aria-label={language.risuBardSaveLoadShortcutClose}
        title={language.risuBardSaveLoadShortcutClose}
        onclick={(event) => activate(event, hideShortcuts)}
    >
        <XIcon size={16} />
    </button>
</div>

<style>
    .save-load-shortcuts {
        position: absolute;
        z-index: 30;
        display: flex;
        align-items: flex-end;
        gap: .35rem;
        padding: .42rem;
        border: 1px solid color-mix(in srgb, var(--color-primary) 34%, var(--color-darkborderc));
        border-radius: .65rem;
        background: color-mix(in srgb, var(--color-darkbg) 92%, transparent);
        box-shadow: 0 .45rem 1.25rem rgb(0 0 0 / 24%);
        backdrop-filter: blur(.55rem);
        cursor: grab;
        touch-action: none;
        user-select: none;
        transform: translate(-50%, -50%);
    }
    .save-load-shortcuts.dragging {
        cursor: grabbing;
        box-shadow: 0 .7rem 1.6rem rgb(0 0 0 / 32%);
    }
    .shortcut-action {
        display: grid;
        justify-items: center;
        gap: .22rem;
    }
    .shortcut-label {
        color: var(--color-textcolor2);
        font-size: .54rem;
        font-weight: 700;
        letter-spacing: .13em;
        line-height: 1;
        text-transform: lowercase;
    }
    .shortcut-button {
        display: grid;
        width: 2.55rem;
        height: 2.55rem;
        place-items: center;
        border: 1px solid color-mix(in srgb, var(--color-primary) 42%, var(--color-darkborderc));
        border-radius: .48rem;
        color: var(--color-textcolor);
        background: color-mix(in srgb, var(--color-primary) 17%, var(--color-darkbg));
        transition: background .14s ease, border-color .14s ease;
    }
    .shortcut-button:hover:not(:disabled) {
        border-color: var(--color-primary);
        background: color-mix(in srgb, var(--color-primary) 28%, var(--color-darkbg));
    }
    .shortcut-button:disabled {
        pointer-events: none;
        opacity: .55;
    }
    .shortcut-close {
        display: grid;
        width: 1.8rem;
        height: 1.8rem;
        margin: 0 0 .38rem .35rem;
        place-items: center;
        border: 0;
        border-radius: 999px;
        color: var(--color-textcolor2);
        background: transparent;
        transition: color .14s ease, background .14s ease;
    }
    .shortcut-close:hover {
        color: var(--color-textcolor);
        background: color-mix(in srgb, var(--color-textcolor) 10%, transparent);
    }
    .shortcut-button:focus-visible,
    .shortcut-close:focus-visible {
        outline: 2px solid var(--color-primary);
        outline-offset: 2px;
    }
    @media (prefers-reduced-motion: reduce) {
        .shortcut-button,
        .shortcut-close { transition: none; }
    }
</style>
