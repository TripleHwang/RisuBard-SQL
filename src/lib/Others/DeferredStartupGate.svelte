<script lang="ts">
    import { startupHydrationErrorStore, startupHydrationStore } from 'src/ts/stores.svelte'
    import { canRetryDeferredSqlStartup, retryDeferredSqlStartup } from 'src/ts/deferredStartupRetry'
    import { language } from 'src/lang'

    // Nothing but a successful hydration pass clears startupHydrationStore, and
    // that pass stops for good once its retry prompt is declined. Without an
    // affordance here the gate is a permanent, full-screen dead end for every
    // surface it protects. Labels reuse existing generic translations.
    const canRetry = canRetryDeferredSqlStartup()
</script>

{#if $startupHydrationStore}
    <div class="absolute inset-0 z-50 flex items-center justify-center bg-black/50" role="status">
        <div class="flex flex-col items-center gap-3">
            {#if $startupHydrationErrorStore}
                <span class="max-w-xs text-center text-sm text-white">{language.savedSettingsLoadError}</span>
                <div class="flex flex-row items-center gap-2">
                    {#if canRetry}
                        <button class="px-4 py-1.5 text-sm text-white/80 hover:text-white border border-white/30 hover:border-white/60 rounded-md transition-colors cursor-pointer" onclick={() => {
                            void retryDeferredSqlStartup()
                        }}>{language.remoteAccessRetry}</button>
                    {/if}
                    <button class="px-4 py-1.5 text-sm text-white/80 hover:text-white border border-white/30 hover:border-white/60 rounded-md transition-colors cursor-pointer" onclick={() => {
                        location.reload()
                    }}>{language.selfUpdateReload}</button>
                </div>
            {:else}
                <svg class="h-8 w-8 animate-spin text-white" style="will-change: transform;" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-hidden="true">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 0 1 8-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                <span class="text-sm text-white">{language.loadingSavedSettings}</span>
            {/if}
        </div>
    </div>
{:else}
    <slot />
{/if}
