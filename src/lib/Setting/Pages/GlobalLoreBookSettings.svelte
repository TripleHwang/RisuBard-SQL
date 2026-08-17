<script lang="ts">
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import LoreBookWorkspaceDialog from "src/lib/SideBars/LoreBook/LoreBookWorkspaceDialog.svelte";
    import {
        coreLorebookScopeKey,
        createLorebookOwnerBinding,
        ensureStableLorebookOwnerId,
    } from "src/lib/SideBars/LoreBook/loreBookWorkspaceConnections";
    import { exportLoreBook, importLoreBook } from "src/ts/process/lorebook.svelte";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { v4 as createUuid } from 'uuid';

    interface Props {
        openLoreList?: boolean;
    }

    let { openLoreList = $bindable(false) }: Props = $props();
    let workspaceOpen = $state(false)
    let activePage = $derived(DBState.db.loreBook[DBState.db.loreBookPage])
    let activeBinding = $derived.by(() => {
        const owner = activePage
        return {
            ...createLorebookOwnerBinding(
                owner,
                owner.data,
                (owner, next) => { owner.data = next },
                (owner) => DBState.db.loreBook.includes(owner),
            ),
            scopeKey: coreLorebookScopeKey({
                kind: 'global-page',
                pageId: ensureStableLorebookOwnerId(owner, createUuid),
            }),
            scopeLabel: `${language.globalLoreBook} · ${owner.name}`,
        }
    })
</script>
<SettingPage title={language.globalLoreBook}>
    <button
        onclick={() => {openLoreList = true}}
        class="mt-4 drop-shadow-lg p-3 flex justify-center items-center ml-2 mr-2 rounded-lg bg-selected mb-4"
    >{activePage.name}</button>

    <button
        data-lorebook-workspace-open
        class="w-full rounded-md border border-selected bg-darkbg p-3 text-left text-textcolor hover:bg-selected"
        aria-label={language.lorebookWorkspace.openScope(activeBinding.scopeLabel)}
        title={language.lorebookWorkspace.open}
        onclick={() => { workspaceOpen = true }}
    >
        <strong>{activeBinding.scopeLabel}</strong>
        <span class="ml-2 text-sm text-textcolor2">{language.lorebookWorkspace.entriesCount(activePage.data.length)}</span>
    </button>

    <LoreBookWorkspaceDialog
        bind:open={workspaceOpen}
        entries={activeBinding.entries}
        scopeKey={activeBinding.scopeKey}
        scopeLabel={activeBinding.scopeLabel}
        onChange={activeBinding.onChange}
        onImport={() => importLoreBook('sglobal')}
        onExport={() => exportLoreBook('sglobal')}
    />
</SettingPage>
