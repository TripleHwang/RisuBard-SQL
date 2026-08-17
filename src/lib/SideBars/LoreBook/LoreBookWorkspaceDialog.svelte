<script lang="ts">
    import { MediaQuery } from 'svelte/reactivity'
    import { language } from 'src/lang'
    import type { loreBook } from 'src/ts/storage/database.svelte'
    import ShDialog from 'src/lib/UI/GUI/ShDialog.svelte'
    import LoreBookWorkspace from './LoreBookWorkspace.svelte'
    import type { LorebookLocalActivation } from './loreBookWorkspaceConnections'

    interface Props {
        open?: boolean
        onOpenChange?: (open: boolean) => void
        entries: loreBook[]
        scopeLabel: string
        scopeKey?: string
        dragEnabled?: boolean
        legacyDisabledBackups?: Record<string, loreBook & { disabled?: boolean }>
        localActivation?: LorebookLocalActivation
        onChange: (entries: loreBook[]) => void
        onImport?: () => void | Promise<void>
        onExport?: () => void | Promise<void>
        resolveChildLabel?: (id: string) => string | undefined
    }

    let {
        open = $bindable(false),
        onOpenChange,
        entries,
        scopeLabel,
        scopeKey,
        dragEnabled = true,
        legacyDisabledBackups,
        localActivation,
        onChange,
        onImport,
        onExport,
        resolveChildLabel,
    }: Props = $props()

    const desktopMedia = new MediaQuery('(min-width: 900px)')
    let contentElement: HTMLElement | null = $state(null)

    $effect(() => {
        if (!open || !contentElement || !desktopMedia.current) return
        const shell = contentElement.querySelector<HTMLElement>('.lore-workspace')
        const splitter = contentElement.querySelector<HTMLElement>('[data-lorebook-splitter]')
        if (!shell || !splitter) return

        let resizing = false
        function onPointerDown(event: PointerEvent) {
            resizing = true
            splitter!.setPointerCapture(event.pointerId)
        }
        function onPointerMove(event: PointerEvent) {
            if (!resizing) return
            const rect = shell!.getBoundingClientRect()
            if (rect.width <= 0) return
            const percent = Math.min(52, Math.max(26, ((event.clientX - rect.left) / rect.width) * 100))
            shell!.style.setProperty('--lore-list-ratio', `${percent}%`)
        }
        function onPointerUp(event: PointerEvent) {
            resizing = false
            if (splitter!.hasPointerCapture(event.pointerId)) splitter!.releasePointerCapture(event.pointerId)
        }
        function resetSplitter() {
            shell!.style.setProperty('--lore-list-ratio', '38%')
        }

        splitter.addEventListener('pointerdown', onPointerDown)
        splitter.addEventListener('pointermove', onPointerMove)
        splitter.addEventListener('pointerup', onPointerUp)
        splitter.addEventListener('pointercancel', onPointerUp)
        splitter.addEventListener('dblclick', resetSplitter)
        return () => {
            splitter.removeEventListener('pointerdown', onPointerDown)
            splitter.removeEventListener('pointermove', onPointerMove)
            splitter.removeEventListener('pointerup', onPointerUp)
            splitter.removeEventListener('pointercancel', onPointerUp)
            splitter.removeEventListener('dblclick', resetSplitter)
        }
    })
</script>

<ShDialog
    bind:open
    {onOpenChange}
    bind:contentElement
    closeOnEscape
    tier="base"
    size="xl"
    contentClass="lore-dialog"
    bodyClass="lore-dialog-body"
    ariaLabel={language.lorebookWorkspace.workspaceLabel(scopeLabel)}
    closeAriaLabel={language.lorebookWorkspace.close}
    closeClass="lore-dialog-close"
>
    {#snippet title()}{scopeLabel}{/snippet}
    <LoreBookWorkspace
        {entries}
        {scopeLabel}
        {scopeKey}
        active={open}
        {dragEnabled}
        {legacyDisabledBackups}
        {localActivation}
        {onChange}
        {onImport}
        {onExport}
        {resolveChildLabel}
    />
</ShDialog>

<style>
    :global(.lore-dialog) {
        width: min(96vw, 1700px);
        max-width: none;
        height: min(92vh, 1000px);
        max-height: 92vh;
        padding: 0;
        overflow: hidden;
        gap: 0;
        background: var(--color-darkbg);
    }
    :global(.lore-dialog > :first-child) {
        min-height: 3.25rem;
        justify-content: center;
        padding: .75rem 4rem .75rem 1rem;
        border-bottom: 1px solid var(--color-darkborderc);
        background: color-mix(in srgb, var(--color-selected) 18%, var(--color-darkbg));
    }
    :global(.lore-dialog-close) {
        top: 50%;
        right: .7rem;
        display: grid;
        width: 2.65rem;
        height: 2.65rem;
        place-items: center;
        border-radius: .72rem;
        background: color-mix(in srgb, var(--color-selected) 58%, var(--color-darkbg));
        color: var(--color-textcolor);
        transform: translateY(-50%);
    }
    :global(.lore-dialog-close:hover) { background: var(--color-selected); }
    :global(.lore-dialog-close svg) { width: 1.35rem; height: 1.35rem; }
    :global(.lore-dialog-body) { min-height: 0; flex: 1; padding: .7rem; }
    @media (max-width: 899px) {
        :global(.lore-dialog) {
            width: 100vw;
            height: 100dvh;
            max-height: none;
            border-radius: 0;
        }
        :global(.lore-dialog-body) { padding: 0; }
        :global(.lore-dialog > :first-child) { min-height: 4rem; padding-right: 4.8rem; }
        :global(.lore-dialog-close) { right: .65rem; width: 3rem; height: 3rem; border-radius: .9rem; }
        :global(.lore-dialog-close svg) { width: 1.55rem; height: 1.55rem; }
    }
</style>
