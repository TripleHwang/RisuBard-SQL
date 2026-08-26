<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { changeColorScheme, changeColorSchemeType, exportColorScheme, importColorScheme, updateColorScheme } from 'src/ts/gui/colorscheme';
    import { builtInColorSchemes, copyColorSchemeForEdit } from 'src/ts/gui/colorschemePalettes';
    import { resolveUiThemeColors, uiThemeTokens, type UiThemeToken } from 'src/ts/gui/uiThemeTokens';
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte';
    import ThemeColorInput from './ThemeColorInput.svelte';

    const baseFields = [
        ['bgcolor', 'Main background', '기본 배경'], ['darkbg', 'Panel background', '패널 배경'],
        ['selected', 'Selected surface', '선택 표면'], ['darkbutton', 'Button surface', '일반 버튼 배경'],
        ['textcolor', 'Text', '기본 글자'], ['textcolor2', 'Muted text', '보조 글자'],
        ['borderc', 'Accent border', '강조 테두리'], ['darkBorderc', 'Panel border', '패널 테두리'],
        ['draculared', 'Legacy destructive accent', '삭제 강조'], ['primary', 'Primary accent', '주 강조색'],
        ['accentText', 'Text on primary accent', '주 강조색 위 글자'],
    ] as const;
    const groups = [
        ['binding', 'Bindings and pinned states', '바인딩·고정 상태'],
        ['status', 'Information, warnings and status', '정보·경고·상태'],
        ['media', 'Overlays, shadows and controls', '오버레이·그림자·컨트롤'],
    ] as const;
    const ko = $derived(DBState.db.language === 'ko');
    const scheme = $derived(DBState.db.colorScheme);
    const roleColors = $derived(resolveUiThemeColors(scheme));

    function editBase(key: typeof baseFields[number][0], value: string) {
        const current = copyColorSchemeForEdit(DBState.db.colorSchemeName, scheme);
        DBState.db.colorSchemeName = 'custom';
        DBState.db.colorScheme = { ...current, [key]: value };
        updateColorScheme();
    }

    function editRole(token: UiThemeToken, value?: string) {
        const current = copyColorSchemeForEdit(DBState.db.colorSchemeName, scheme);
        const uiColors = { ...current.uiColors };
        if (value === undefined) delete uiColors[token];
        else uiColors[token] = value;
        DBState.db.colorSchemeName = 'custom';
        DBState.db.colorScheme = { ...current, uiColors };
        updateColorScheme();
    }
</script>

<section class="py-3 text-textcolor" aria-label={ko ? '테마 세부 색상' : 'Theme color details'}>
    <h3 class="text-sm font-semibold">{ko ? '테마 세부 색상' : 'Theme color details'}</h3>
    <p class="mt-1 text-xs text-textcolor2">
        {ko ? '색을 바꾸면 현재 스킨을 Custom으로 복사합니다. 항목별 초기화는 현재 라이트·다크 모드의 기본색을 복원합니다.' : 'Editing a color copies the current skin to Custom. Each reset restores the default for the current light or dark mode.'}
    </p>

    {#if DBState.db.colorSchemeName === 'custom'}
        <label class="mt-3 flex items-center justify-between gap-3 text-sm">
            <span>{ko ? '기본 모드' : 'Base mode'}</span>
            <select class="rounded border border-darkborderc bg-darkbg px-2 py-1 text-textcolor" value={scheme.type} onchange={(event) => changeColorSchemeType(event.currentTarget.value as 'light' | 'dark')}>
                <option value="light">Light</option><option value="dark">Dark</option>
            </select>
        </label>
    {/if}

    <details class="mt-3 border-t border-darkborderc pt-2">
        <summary class="cursor-pointer text-sm">{ko ? '배경·글자·기본 강조색' : 'Surfaces, text and accents'}</summary>
        {#each baseFields as [key, label, labelKo]}
            <div class="flex items-center justify-between gap-3 py-2">
                <label class="min-w-0 text-sm" for={`theme-base-${key}`}>{ko ? labelKo : label}</label>
                <div class="flex shrink-0 items-center gap-2">
                    <ThemeColorInput id={`theme-base-${key}`} data-base-color={key} label={ko ? labelKo : label} value={scheme[key]} allowCss onChange={(value) => editBase(key, value)} />
                    <ShButton size="xs" variant="ghost" aria-label={`${ko ? labelKo : label} ${ko ? '초기화' : 'reset'}`} onclick={() => editBase(key, builtInColorSchemes[scheme.type][key])}>{ko ? '초기화' : 'Reset'}</ShButton>
                </div>
            </div>
        {/each}
    </details>

    {#each groups as [group, label, labelKo]}
        <details class="mt-2 border-t border-darkborderc pt-2" open={group === 'binding'}>
            <summary class="cursor-pointer text-sm">{ko ? labelKo : label}</summary>
            {#each uiThemeTokens.filter((field) => field.group === group) as field}
                <div class="flex items-center justify-between gap-3 py-2">
                    <label class="min-w-0 text-sm" for={`theme-role-${field.token}`}>{ko ? field.labelKo : field.label}</label>
                    <div class="flex shrink-0 items-center gap-2">
                        <ThemeColorInput id={`theme-role-${field.token}`} data-ui-color={field.token} label={ko ? field.labelKo : field.label} value={roleColors[field.token]} onChange={(value) => editRole(field.token, value)} />
                        <ShButton size="xs" variant="ghost" data-reset-ui-color={field.token} disabled={scheme.uiColors?.[field.token] === undefined} aria-label={`${ko ? field.labelKo : field.label} ${ko ? '초기화' : 'reset'}`} onclick={() => editRole(field.token)}>{ko ? '초기화' : 'Reset'}</ShButton>
                    </div>
                </div>
            {/each}
        </details>
    {/each}

    <div class="mt-3 flex flex-wrap justify-end gap-2">
        <ShButton size="sm" variant="ghost" onclick={() => changeColorScheme(scheme.type)}>{ko ? '전체 기본색 복원' : 'Restore default colors'}</ShButton>
        <ShButton size="sm" onclick={exportColorScheme}>{ko ? '색상 내보내기' : 'Export colors'}</ShButton>
        <ShButton size="sm" onclick={importColorScheme}>{ko ? '색상 가져오기' : 'Import colors'}</ShButton>
    </div>
</section>
