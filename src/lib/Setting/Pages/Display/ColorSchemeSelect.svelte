<script lang="ts">
    import { language } from 'src/lang';
    import { DBState } from 'src/ts/stores.svelte';
    import { changeColorScheme, colorSchemeList, colorSchemeLabels } from 'src/ts/gui/colorscheme';
    import { builtInColorSchemes } from 'src/ts/gui/colorschemePalettes';

    const optionLabel = (scheme: string) => colorSchemeLabels[scheme] ?? scheme;
</script>

<section class="py-3 border-t border-darkborderc">
    <div class="flex flex-col min-w-0">
        <span class="text-sm text-textcolor">{language.colorScheme}</span>
        {#if language.help.colorScheme}<p class="text-xs text-textcolor2 mt-0.5">{language.help.colorScheme}</p>{/if}
    </div>
    <div class="mt-3 grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2">
        {#each colorSchemeList as scheme}
            <button type="button" class="rounded border p-2 text-left" class:border-primary={DBState.db.colorSchemeName === scheme} class:border-darkborderc={DBState.db.colorSchemeName !== scheme} onclick={() => changeColorScheme(scheme)}>
                <span class="mb-2 block h-7 rounded" style:background={builtInColorSchemes[scheme].bgcolor}></span>{optionLabel(scheme)}
            </button>
        {/each}
        <button type="button" class="rounded border border-darkborderc p-2 text-left" class:border-primary={DBState.db.colorSchemeName === 'custom'} onclick={() => changeColorScheme('custom')}>Custom</button>
    </div>
</section>
