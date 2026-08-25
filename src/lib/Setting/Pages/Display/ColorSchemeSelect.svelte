<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import { changeColorScheme, colorSchemeList, colorSchemeLabels, type ColorScheme } from 'src/ts/gui/colorscheme';
    import { builtInColorSchemes } from 'src/ts/gui/colorschemePalettes';
    import { CheckIcon } from '@lucide/svelte';

    const optionLabel = (scheme: string) => colorSchemeLabels[scheme] ?? scheme;
    const isSelected = (scheme: string) => DBState.db.colorSchemeName === scheme;
</script>

{#snippet palettePreview(scheme: ColorScheme)}
    <span
        class="palette-preview block h-16 overflow-hidden rounded-md border"
        style:background-color={scheme.bgcolor}
        style:border-color={scheme.borderc}
        aria-hidden="true"
    >
        <span
            class="m-2 flex h-12 items-center gap-2 rounded border px-2"
            style:background-color={scheme.darkbg}
            style:border-color={scheme.darkBorderc}
        >
            <span class="min-w-0 flex-1">
                <span class="block text-left text-xs font-semibold" style:color={scheme.textcolor}>Aa</span>
                <span class="mt-1 block h-1.5 w-full rounded-full" style:background-color={scheme.selected}></span>
            </span>
            <span
                class="inline-flex size-6 shrink-0 items-center justify-center rounded text-[10px] font-bold"
                style:background-color={scheme.primary}
                style:color={scheme.accentText}
            >Aa</span>
        </span>
    </span>
{/snippet}

<section class="border-t border-darkborderc py-3" aria-labelledby="color-scheme-label">
    <div class="min-w-0">
        <span id="color-scheme-label" class="text-sm text-textcolor">{language.colorScheme}</span>
        {#if language.help.colorScheme}<p class="text-xs text-textcolor2 mt-0.5">{language.help.colorScheme}</p>{/if}
    </div>

    <div class="mt-3 grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-2" role="group" aria-labelledby="color-scheme-label">
        {#each colorSchemeList as scheme}
            <button
                type="button"
                data-color-scheme-card={scheme}
                class="relative min-w-0 rounded-lg border p-2 text-left transition-colors hover:bg-darkbutton focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                class:border-primary={isSelected(scheme)}
                class:border-darkborderc={!isSelected(scheme)}
                class:bg-selected={isSelected(scheme)}
                class:ring-2={isSelected(scheme)}
                class:ring-primary={isSelected(scheme)}
                aria-pressed={isSelected(scheme)}
                aria-label={optionLabel(scheme)}
                onclick={() => changeColorScheme(scheme)}
            >
                {#if isSelected(scheme)}
                    <span class="absolute right-1.5 top-1.5 z-10 inline-flex size-5 items-center justify-center rounded-full bg-primary text-accenttext" aria-hidden="true">
                        <CheckIcon size={12} strokeWidth={3} />
                    </span>
                {/if}
                {@render palettePreview(builtInColorSchemes[scheme])}
                <span class="mt-2 block truncate text-sm font-medium text-textcolor">{optionLabel(scheme)}</span>
            </button>
        {/each}

        <button
            type="button"
            data-color-scheme-card="custom"
            class="relative min-w-0 rounded-lg border p-2 text-left transition-colors hover:bg-darkbutton focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            class:border-primary={isSelected('custom')}
            class:border-darkborderc={!isSelected('custom')}
            class:bg-selected={isSelected('custom')}
            class:ring-2={isSelected('custom')}
            class:ring-primary={isSelected('custom')}
            aria-pressed={isSelected('custom')}
            aria-label="Custom"
            onclick={() => changeColorScheme('custom')}
        >
            {#if isSelected('custom')}
                <span class="absolute right-1.5 top-1.5 z-10 inline-flex size-5 items-center justify-center rounded-full bg-primary text-accenttext" aria-hidden="true">
                    <CheckIcon size={12} strokeWidth={3} />
                </span>
            {/if}
            {@render palettePreview(DBState.db.colorScheme)}
            <span class="mt-2 block truncate text-sm font-medium text-textcolor">Custom</span>
        </button>
    </div>
</section>
