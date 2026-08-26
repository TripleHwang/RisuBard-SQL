<script lang="ts">
    import { tick } from 'svelte'
    import { nextRovingIndex, scrollTopForIndex, visibleRange } from './virtualCharacterList'

    interface Props { count: number; rowHeight?: number; overscan?: number; getKey?: (index: number) => string | number; children: import('svelte').Snippet<[number, number]> }
    let { count, rowHeight = 68, overscan = 8, getKey = (index) => index, children }: Props = $props()
    let scrollTop = $state(0)
    let height = $state(680)
    let viewport: HTMLDivElement
    let focusedIndex = $state(0)
    $effect(() => {
        const observer = new ResizeObserver(() => height = viewport.clientHeight)
        observer.observe(viewport); return () => observer.disconnect()
    })
    let range = $derived(visibleRange({ count, scrollTop, height, rowHeight, overscan }))

    async function focusIndex(index: number) {
        focusedIndex = index
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

<div bind:this={viewport} class="h-full w-full overflow-y-auto" role="region" aria-label="Character list" onscroll={() => scrollTop = viewport.scrollTop} onkeydown={onKeydown} onfocusin={(event) => {
    const index = Number((event.target as HTMLElement).dataset.virtualIndex)
    if (Number.isInteger(index)) focusedIndex = index
}}>
    <div style:height={`${count * rowHeight}px`} class="relative">
        <div class="absolute w-full" style:transform={`translateY(${range.start * rowHeight}px)`}>
            {#each Array(range.end - range.start) as _, offset (getKey(range.start + offset))}
                {@render children(range.start + offset, focusedIndex)}
            {/each}
        </div>
    </div>
</div>
