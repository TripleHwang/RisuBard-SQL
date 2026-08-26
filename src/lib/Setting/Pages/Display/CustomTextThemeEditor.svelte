<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { updateTextThemeAndCSS } from 'src/ts/gui/colorscheme';
    import { resolveChatTextSurface, resolveTextTheme } from 'src/ts/gui/textTheme';
    import ColorInput from 'src/lib/UI/GUI/ColorInput.svelte';

    const colors = [
        ['FontColorStandard', 'Normal Text', false],
        ['FontColorItalic', 'Italic Text', false],
        ['FontColorBold', 'Bold Text', false],
        ['FontColorItalicBold', 'Italic Bold Text', false],
        ['FontColorQuote1', 'Single Quote Text', true],
        ['FontColorQuote2', 'Double Quote Text', true],
    ] as const;
    let preview = $derived(resolveTextTheme(
        DBState.db.textTheme,
        DBState.db.colorScheme.type,
        DBState.db.customTextTheme,
        {
            autoContrast: DBState.db.textThemeAutoContrast !== false,
            backgrounds: resolveChatTextSurface(DBState.db.colorScheme, DBState.db).backgrounds,
        },
    ));
</script>

<section class="py-3" aria-label="Text colors">
    <label class="flex items-center justify-between gap-3 py-2 text-sm text-textcolor"><span>Automatically correct text contrast</span><input type="checkbox" checked={DBState.db.textThemeAutoContrast !== false} onchange={(event) => { DBState.db.textThemeAutoContrast = event.currentTarget.checked; updateTextThemeAndCSS() }} /></label>
    <div class="mb-2 rounded border border-darkborderc bg-bgcolor p-3 text-sm"><span style:color={preview.FontColorStandard}>Readable text </span><span class="italic" style:color={preview.FontColorItalic}>and italic text. </span><span style:color={preview.FontColorQuote2}>“Quoted dialogue preview.”</span></div>
    {#each colors as color}
        <div class="flex items-center justify-between gap-3 py-2">
            <span class="text-sm text-textcolor min-w-0 truncate">{color[1]}</span>
            <div class="shrink-0">
                <ColorInput
                    nullable={color[2]}
                    bind:value={DBState.db.customTextTheme[color[0]]}
                    oninput={updateTextThemeAndCSS}
                />
            </div>
        </div>
    {/each}
</section>
