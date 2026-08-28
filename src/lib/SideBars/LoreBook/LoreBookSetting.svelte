<script lang="ts">
    import { DBState } from 'src/ts/stores.svelte';
    import { language } from "../../../lang";
    import { SunIcon, LinkIcon } from "@lucide/svelte";
    import { exportLoreBook, importLoreBook } from "../../../ts/process/lorebook.svelte";
    import Check from "../../UI/GUI/CheckInput.svelte";
    import NumberInput from "../../UI/GUI/NumberInput.svelte";
    import ShSelect from "../../UI/GUI/ShSelect.svelte";
    import OptionInput from "../../UI/GUI/OptionInput.svelte";
    import SolarBoldIcon from "../../UI/Icons/SolarBoldIcon.svelte";
    import LoreBookList from "./LoreBookList.svelte";
    import LoreBookWorkspaceDialog from "./LoreBookWorkspaceDialog.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import { selectedCharID } from "src/ts/stores.svelte";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import {
        coreLorebookScopeKey,
        createCharacterLocalActivationBinding,
        createLorebookOwnerBinding,
        ensureStableLorebookOwnerId,
        loremasterDisabledBackupKey,
        readLoremasterDisabledBackups,
        resolveCharacterGlobalLoreLabel,
    } from './loreBookWorkspaceConnections';
    import { v4 as createUuid } from 'uuid';
    import { notifyError } from 'src/ts/alert';
    import { isRootKeyDeferred } from 'src/ts/storage/sql/deferredRootKeys';
    import { ensureRootKeyHydrated } from 'src/ts/storage/sql/sqlRuntimeHydration';

    let submenu = $state(0)
    let workspaceOpen = $state(false)
    let activeBinding = $derived.by(() => {
        const character = DBState.db.characters[$selectedCharID]
        if (submenu === 0) {
            const chat = character.chats[character.chatPage]
            return {
                ...createLorebookOwnerBinding(
                    character,
                    character.globalLore,
                    (owner, next) => { owner.globalLore = next },
                    (owner) => DBState.db.characters.includes(owner),
                ),
                scopeKey: coreLorebookScopeKey({ kind: 'character', chaId: character.chaId }),
                scopeLabel: `${character.name} · ${language.character}`,
                localActivation: createCharacterLocalActivationBinding(
                    character,
                    chat,
                    DBState.db.localActivationInGlobalLorebook,
                    () => DBState.db.characters,
                ),
            }
        }
        const chat = character.chats[character.chatPage]
        return {
            ...createLorebookOwnerBinding(
                chat,
                chat.localLore,
                (owner, next) => { owner.localLore = next },
                (owner) => DBState.db.characters.includes(character) && character.chats.includes(owner),
            ),
            scopeKey: coreLorebookScopeKey({
                kind: 'chat',
                chaId: character.chaId,
                chatId: ensureStableLorebookOwnerId(chat, createUuid),
            }),
            scopeLabel: `${character.name} · ${chat.name || language.Chat}`,
            localActivation: undefined,
        }
    })
    /**
     * `activeLoremasterBackups` reads `DBState.db.pluginCustomStorage` during
     * render, and the SQL bootstrap withholds that map until something asks for
     * it. A withheld map would make every Loremaster backup look absent, and
     * the workspace's restore action reads that as "there is nothing to
     * restore" — a definite negative drawn from a map nobody loaded.
     *
     * Render cannot await, so the wait happens at the only door into the
     * workspace: the dialog does not open until the map is resident. A failed
     * load says so and keeps the dialog shut, rather than opening it onto a
     * false empty.
     */
    async function openWorkspace() {
        if (isRootKeyDeferred('pluginCustomStorage')) {
            try {
                await ensureRootKeyHydrated(DBState.db, 'pluginCustomStorage')
            } catch (error) {
                console.error('[Lorebook] plugin storage could not be loaded', error)
                notifyError(language.pluginStorageLoadError)
                return
            }
        }
        workspaceOpen = true
    }

    let activeLoremasterBackups = $derived.by(() => {
        const character = DBState.db.characters[$selectedCharID]
        const key = submenu === 0
            ? loremasterDisabledBackupKey({ kind: 'character', chaId: character.chaId })
            : loremasterDisabledBackupKey({
                kind: 'chat',
                chaId: character.chaId,
                chatId: ensureStableLorebookOwnerId(
                    character.chats[character.chatPage],
                    createUuid,
                ),
            })
        return key
            ? readLoremasterDisabledBackups(DBState.db.pluginCustomStorage, key)
            : undefined
    })
    let activeChildLabelResolver = $derived(
        submenu === 1
            ? (id: string) => resolveCharacterGlobalLoreLabel(
                DBState.db.characters[$selectedCharID].globalLore,
                id,
            )
            : undefined
    )

    function isAllCharacterLoreAlwaysActive() {
        const globalLore = DBState.db.characters[$selectedCharID].globalLore;
        return globalLore && globalLore.every((book) => book.alwaysActive);
    }

    function isAllChatLoreAlwaysActive() {
        const localLore = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore;
        return localLore && localLore.every((book) => book.alwaysActive);
    }

    function toggleCharacterLoreAlwaysActive() {
        const globalLore = DBState.db.characters[$selectedCharID].globalLore;

        if (!globalLore) return;
        
        const allActive = globalLore.every((book) => book.alwaysActive);
        
        globalLore.forEach((book) => {
            book.alwaysActive = !allActive;
        });
    }

    function toggleChatLoreAlwaysActive() {
        const localLore = DBState.db.characters[$selectedCharID].chats[DBState.db.characters[$selectedCharID].chatPage].localLore;

        if (!localLore) return;

        const allActive = localLore.every((book) => book.alwaysActive);

        localLore.forEach((book) => {
            book.alwaysActive = !allActive;
        });
    }
</script>

<div class="flex w-full rounded-md border border-selected">
    <button onclick={() => {
        submenu = 0
    }} class="p-2 flex-1" class:bg-selected={submenu === 0} title={language.globalLoreInfo}>
        <span>{language.character}</span>
    </button>
    <button onclick={() => {
        submenu = 1
    }} class="p2 flex-1 border-r border-l border-selected" class:bg-selected={submenu === 1} title={language.localLoreInfo}>
        <span>{language.Chat}</span>
    </button>
    <button onclick={() => {
        submenu = 2
    }} class="p-2 flex-1" class:bg-selected={submenu === 2}>
        <span>{language.settings}</span>
    </button>
</div>
{#if submenu !== 2}
    <button
        data-lorebook-workspace-open
        class="mt-2 mb-3 flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-info px-4 py-2.5 font-semibold text-on-info shadow-sm transition-colors hover:bg-info/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-info active:bg-info/75"
        aria-label={language.lorebookWorkspace.openScope(activeBinding.scopeLabel)}
        title={language.lorebookWorkspace.open}
        onclick={openWorkspace}
    >
        <SolarBoldIcon name="notebook" size={20} />
        <span>{language.lorebookWorkspace.editor}</span>
    </button>
    <LoreBookList {submenu} />
    {#if DBState.db.bulkEnabling}
        <div class="text-textcolor2 mt-2 flex">
            <button onclick={() => {
                toggleCharacterLoreAlwaysActive()
            }} class="hover:text-textcolor cursor-pointer flex items-center gap-1">
                {#if isAllCharacterLoreAlwaysActive()}
                    <SunIcon />
                {:else}
                    <LinkIcon />
                {/if}
                <span class="text-xs">{language.character}</span>
            </button>
            <button onclick={() => {
                toggleChatLoreAlwaysActive()
            }} class="hover:text-textcolor ml-2 cursor-pointer flex items-center gap-1">
                {#if isAllChatLoreAlwaysActive()}
                    <SunIcon />
                {:else}
                    <LinkIcon />
                {/if}
                <span class="text-xs">{language.Chat}</span>
            </button>
        </div>
    {/if}
{:else}
    {#if DBState.db.characters[$selectedCharID].loreSettings}
        <div class="flex items-center mt-4">
            <Check check={false} onChange={() => {
                DBState.db.characters[$selectedCharID].loreSettings = undefined
            }}
            name={language.useGlobalSettings}
            />
            <Help key="useGlobalSettings"/>
        </div>
        <div class="flex items-center mt-4">
            <Check bind:check={DBState.db.characters[$selectedCharID].loreSettings.recursiveScanning} name={language.recursiveScanning}/>
            <Help key="recursiveScanning"/>
        </div>
        {#if DBState.db.characters[$selectedCharID].loreSettings.recursiveScanning}
            <span class="text-textcolor mt-4 mb-2">{language.maxRecursionSteps} <Help key="maxRecursionSteps"/></span>
            <NumberInput min={0} max={20} bind:value={DBState.db.characters[$selectedCharID].loreSettings.maxRecursionSteps} />
        {/if}
        <span class="text-textcolor mt-4 mb-2">{language.lorebookMatchingMode} <Help key="lorebookMatchingMode"/></span>
        <ShSelect className="mb-2" bind:value={DBState.db.characters[$selectedCharID].loreSettings.matchingMode}>
            <OptionInput value="partial">{language.partialMatching}</OptionInput>
            <OptionInput value="whitespace">{language.fullWordMatching}</OptionInput>
            <OptionInput value="word-boundary">{language.wordBoundaryMatching}</OptionInput>
        </ShSelect>
        <span class="text-textcolor mt-4 mb-2">{language.loreBookDepth} <Help key="loreBookDepth"/></span>
        <NumberInput min={0} max={20} bind:value={DBState.db.characters[$selectedCharID].loreSettings.scanDepth} />
        <span class="text-textcolor">{language.loreBookToken} <Help key="loreBookToken"/></span>
        <NumberInput min={0} max={4096} bind:value={DBState.db.characters[$selectedCharID].loreSettings.tokenBudget} />
    {:else}
        <div class="flex items-center mt-4">
            <Check check={true} onChange={() => {
                DBState.db.characters[$selectedCharID].loreSettings = {
                    tokenBudget: DBState.db.loreBookToken,
                    scanDepth:DBState.db.loreBookDepth,
                    recursiveScanning: false,
                    maxRecursionSteps: 0,
                    fullWordMatching: false,
                    matchingMode: 'partial'
                }
            }}
            name={language.useGlobalSettings}
            />
            <Help key="useGlobalSettings"/>
        </div>
    {/if}
{/if}

<LoreBookWorkspaceDialog
    bind:open={workspaceOpen}
    entries={activeBinding.entries}
    scopeKey={activeBinding.scopeKey}
    scopeLabel={activeBinding.scopeLabel}
    legacyDisabledBackups={activeLoremasterBackups}
    resolveChildLabel={activeChildLabelResolver}
    localActivation={activeBinding.localActivation}
    onChange={activeBinding.onChange}
    onImport={() => importLoreBook(submenu === 0 ? 'global' : 'local')}
    onExport={() => exportLoreBook(submenu === 0 ? 'global' : 'local')}
/>
