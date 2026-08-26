<script lang="ts">
    import { visibleRange } from './virtualCharacterList'

    interface Props { count: number; rowHeight?: number; overscan?: number; getKey?: (index: number) => string | number; children: import('svelte').Snippet<[number]> }
    let { count, rowHeight = 68, overscan = 8, getKey = (index) => index, children }: Props = $props()
    let scrollTop = $state(0)
    let height = $state(680)
    let viewport: HTMLDivElement
    $effect(() => {
        const observer = new ResizeObserver(() => height = viewport.clientHeight)
        observer.observe(viewport); return () => observer.disconnect()
    })
    let range = $derived(visibleRange({ count, scrollTop, height, rowHeight, overscan }))
</script>

<div bind:this={viewport} class="h-full w-full overflow-y-auto" onscroll={() => scrollTop = viewport.scrollTop}>
    <div style:height={`${count * rowHeight}px`} class="relative">
        <div class="absolute w-full" style:transform={`translateY(${range.start * rowHeight}px)`}>
            {#each Array(range.end - range.start) as _, offset (getKey(range.start + offset))}
                {@render children(range.start + offset)}
            {/each}
        </div>
    </div>
</div>
