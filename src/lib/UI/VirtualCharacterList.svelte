<script lang="ts">
    import { tick } from 'svelte'
    import { nextRovingIndex, reconcileFocus, scrollTopForIndex, shouldRecoverListFocus, visibleRange } from './virtualCharacterList'

    interface Props { count: number; itemsSignature: string; rowHeight?: number; overscan?: number; getKey?: (index: number) => string | number; children: import('svelte').Snippet<[number, number, string | number]> }
    let { count, itemsSignature, rowHeight = 68, overscan = 8, getKey = (index) => index, children }: Props = $props()
    let scrollTop = $state(0)
    let height = $state(680)
    let viewport: HTMLDivElement
    let focusedIndex = $state(0)
    let focusedKey = $state<string | number | null>(null)
    let hasListFocus = $state(false)
    $effect(() => {
        const observer = new ResizeObserver(() => height = viewport.clientHeight)
        observer.observe(viewport); return () => observer.disconnect()
    })
    let range = $derived(visibleRange({ count, scrollTop, height, rowHeight, overscan }))
    let focusedMounted = $derived(focusedIndex >= range.start && focusedIndex < range.end)
    $effect(() => {
        itemsSignature
        const keys = Array.from({ length: count }, (_, index) => getKey(index))
        const next = reconcileFocus(keys, focusedKey, focusedIndex)
        focusedKey = next.key
        focusedIndex = next.index
    })
    $effect(() => {
        if (!shouldRecoverListFocus(hasListFocus, focusedMounted)) return
        void tick().then(() => {
            if (shouldRecoverListFocus(hasListFocus, focusedMounted)) viewport.focus()
        })
    })

    async function focusIndex(index: number) {
        focusedIndex = index
        focusedKey = getKey(index)
        viewport.scrollTop = scrollTopForIndex(index, viewport.scrollTop, height, rowHeight)
        scrollTop = viewport.scrollTop
        await tick()
        viewport.querySelector<HTMLElement>(`[data-virtual-index="${index}"]`)?.focus()
    }

    function onKeydown(event: KeyboardEvent) {
        if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        void focusIndex(nextRovingIndex(focusedIndex, event.key, count))
    }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- virtual scroller delegates keyboard focus to child buttons -->
<div bind:this={viewport} class="h-full w-full overflow-y-auto" role="listbox" aria-label="Character list" tabindex={focusedMounted ? -1 : 0} aria-activedescendant={focusedMounted ? undefined : `virtual-character-${focusedKey}`} onscroll={() => scrollTop = viewport.scrollTop} onkeydown={onKeydown} onfocusin={(event) => {
    hasListFocus = true
    const index = Number((event.target as HTMLElement).dataset.virtualIndex)
    if (Number.isInteger(index)) { focusedIndex = index; focusedKey = getKey(index) }
}} onfocusout={(event) => {
    const next = event.relatedTarget as Node | null
    if (next && !viewport.contains(next)) hasListFocus = false
}}>
    {#if !focusedMounted && focusedKey !== null}
        <span id={`virtual-character-${focusedKey}`} class="sr-only" role="option" aria-selected="true"></span>
    {/if}
    <div style:height={`${count * rowHeight}px`} class="relative">
        <div class="absolute w-full" style:transform={`translateY(${range.start * rowHeight}px)`}>
            {#each Array(range.end - range.start) as _, offset (getKey(range.start + offset))}
                {@render children(range.start + offset, focusedIndex, getKey(range.start + offset))}
            {/each}
        </div>
    </div>
</div>
