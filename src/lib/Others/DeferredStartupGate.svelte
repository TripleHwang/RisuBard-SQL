<script lang="ts">
    import { startupHydrationErrorStore, startupHydrationStore } from 'src/ts/stores.svelte'
    import { language } from 'src/lang'
</script>

{#if $startupHydrationStore}
    <div class="absolute inset-0 z-50 flex items-center justify-center bg-black/50" role="status">
        <div class="flex flex-col items-center gap-3">
            <svg class="h-8 w-8 animate-spin text-white" style="will-change: transform;" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <span class="text-sm text-white">{$startupHydrationErrorStore
                ? language.savedSettingsLoadError
                : language.loadingSavedSettings}</span>
        </div>
    </div>
{:else}
    <slot />
{/if}
