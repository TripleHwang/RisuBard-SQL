<script lang="ts">
    import { startupHydrationErrorStore, startupHydrationStore } from 'src/ts/stores.svelte'
</script>

{#if $startupHydrationStore}
    <div class="m-4 rounded-md border border-darkborderc bg-darkbg px-4 py-3 text-sm text-textcolor2" role="status">
        {$startupHydrationErrorStore
            ? 'Saved settings could not finish loading. This area stays locked; retry or recovery is available from the startup prompt.'
            : 'Loading saved settings…'}
    </div>
{:else}
    <slot />
{/if}
