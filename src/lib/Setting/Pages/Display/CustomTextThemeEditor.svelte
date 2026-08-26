<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { updateTextThemeAndCSS } from 'src/ts/gui/colorscheme';
    import { resolveChatTextSurface, resolveTextTheme, textThemeFields, type TextThemeColors } from 'src/ts/gui/textTheme';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import ThemeColorInput from './ThemeColorInput.svelte';

    const ko = $derived(DBState.db.language === 'ko');
    const rendered = $derived(resolveTextTheme(DBState.db.textTheme, DBState.db.colorScheme.type, DBState.db.customTextTheme, {
        autoContrast: DBState.db.textThemeAutoContrast !== false,
        backgrounds: resolveChatTextSurface(DBState.db.colorScheme, DBState.db).backgrounds,
    }));
    const requested = $derived(resolveTextTheme(DBState.db.textTheme, DBState.db.colorScheme.type, DBState.db.customTextTheme, { autoContrast: false }));

    function editColor(key: keyof TextThemeColors, value: string) {
        DBState.db.customTextTheme = { ...requested, [key]: value };
        DBState.db.textTheme = 'custom';
        updateTextThemeAndCSS();
    }
</script>

<section class="py-3 text-textcolor" aria-label={ko ? '글자·캐릭터 대사 색상' : 'Text and character dialogue colors'}>
    <h3 class="text-sm font-semibold">{ko ? '글자·캐릭터 대사 색상' : 'Text and character dialogue colors'}</h3>
    <p class="mt-1 text-xs text-textcolor2">
        {ko ? '작은따옴표·큰따옴표 대사와 인용문에 적용됩니다. 색을 바꾸면 글자 테마가 Custom으로 전환됩니다.' : 'Applies to quoted dialogue and blockquotes. Editing a color switches the text theme to Custom.'}
    </p>
    <label class="my-3 flex items-center justify-between gap-3 text-sm">
        <span>{ko ? '글자 대비 자동 보정' : 'Automatically correct text contrast'}</span>
        <input type="checkbox" data-text-auto-contrast class="size-4 accent-primary" checked={DBState.db.textThemeAutoContrast !== false} onchange={(event) => {
            DBState.db.textThemeAutoContrast = event.currentTarget.checked;
            updateTextThemeAndCSS();
        }} />
    </label>
    <p class="mb-2 text-xs text-textcolor2">{ko ? '저장한 색은 유지하고 표시할 때만 밝기를 보정합니다. 입력한 색 그대로 사용하려면 끄세요.' : 'Saved colors are preserved; only displayed brightness is corrected. Disable this to use your exact colors.'}</p>

    {#each textThemeFields as field}
        <div class="flex items-center justify-between gap-3 py-2">
            <label for={`theme-text-${field.key}`} class="min-w-0 text-sm">{ko ? field.labelKo : field.label}</label>
            <div class="flex shrink-0 items-center gap-2">
                <span class="text-xs" style:color={rendered[field.key]} aria-hidden="true">Aa</span>
                <ThemeColorInput id={`theme-text-${field.key}`} data-text-color={field.key} label={ko ? field.labelKo : field.label} value={requested[field.key]} allowCss onChange={(value) => editColor(field.key, value)} />
            </div>
        </div>
    {/each}

    <div class="mt-2 rounded-md border border-darkborderc bg-bgcolor p-3 text-sm leading-relaxed" aria-label={ko ? '대사 색상 미리보기' : 'Dialogue color preview'}>
        <p style:color={rendered.FontColorStandard}>{ko ? '그녀가 책을 덮고 조용히 말했다.' : 'She closed the book and spoke softly.'}</p>
        <p class="mt-2 border-l-2 pl-3" style:color={rendered.FontColorQuote2} style:border-color={rendered.FontColorQuote2}>{ko ? '“이제 밝은 화면에서도 대사를 편하게 읽을 수 있어요.”' : '“Dialogue is readable on a light background, too.”'}</p>
        <p class="mt-2 italic" style:color={rendered.FontColorItalic}>{ko ? '잠시 생각에 잠겼다.' : 'She paused to think.'}</p>
    </div>
    <div class="mt-2 flex justify-end">
        <ShButton size="sm" variant="ghost" data-reset-text-colors onclick={() => {
            DBState.db.textTheme = 'standard';
            DBState.db.textThemeAutoContrast = true;
            updateTextThemeAndCSS();
        }}>{ko ? '테마 기본 글자색 복원' : 'Restore theme text defaults'}</ShButton>
    </div>
</section>
