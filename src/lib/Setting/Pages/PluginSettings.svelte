<script lang="ts">
    import { PlusIcon, TrashIcon, LinkIcon, CodeXmlIcon, PowerIcon, PowerOffIcon, ShieldIcon } from "@lucide/svelte";
    import { language } from "src/lang";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import { alertConfirm, alertMd, alertSelect, notifyError, notifySuccess } from "src/ts/alert";
    import { TriangleAlert } from '@lucide/svelte';

    import { DBState, hotReloading } from "src/ts/stores.svelte";
    import { checkPluginUpdate, createBlankPlugin, importPlugin, loadPlugins, updatePlugin } from "src/ts/plugins/plugins.svelte";
    import { requestImmediateSave } from "src/ts/globalApi.svelte";
    import { resetPluginPermission } from "src/ts/plugins/apiV3/v3.svelte";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import NumberInput from "src/lib/UI/GUI/NumberInput.svelte";
    import SelectInput from "src/lib/UI/GUI/SelectInput.svelte";
    import OptionInput from "src/lib/UI/GUI/OptionInput.svelte";
    import CheckInput from "src/lib/UI/GUI/CheckInput.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { hotReloadPluginFiles } from "src/ts/plugins/apiV3/developMode";
    import CollectionOrganizerList from "src/lib/UI/CollectionOrganizerList.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    import { assignCollectionItem, normalizeCollectionOrganizerState } from "src/ts/collectionOrganizer";

    let showParams = $state<string[]>([])
    let updatingPlugins = $state<string[]>([])
    let selectedPluginFolder = $state<string | null | undefined>(undefined)
    const organizerPluginItems = $derived((DBState.db.plugins ?? []).map((plugin) => ({
        id: plugin.name,
        title: plugin.displayName ?? plugin.name,
        detail: plugin.versionOfPlugin ?? (plugin.version ? String(plugin.version) : ''),
    })))

    async function installPluginUpdate(plugin: (typeof DBState.db.plugins)[number]) {
        if (updatingPlugins.includes(plugin.name)) return
        updatingPlugins = [...updatingPlugins, plugin.name]
        try {
            if (await updatePlugin(plugin)) notifySuccess(language.pluginUpdateSuccess)
            else notifyError(language.pluginUpdateFailed)
        } finally {
            updatingPlugins = updatingPlugins.filter((name) => name !== plugin.name)
        }
    }

    function assignPluginToFolder(pluginName: string, folderId: string | null | undefined) {
        if (typeof folderId !== 'string' || !DBState.db.collectionOrganizers) return
        const pluginNames = (DBState.db.plugins ?? []).map((plugin) => plugin.name)
        const current = normalizeCollectionOrganizerState(DBState.db.collectionOrganizers.plugins, pluginNames)
        DBState.db.collectionOrganizers = {
            ...DBState.db.collectionOrganizers,
            plugins: assignCollectionItem(current, pluginName, folderId),
        }
        void requestImmediateSave()
    }

    async function importPluginsToSelectedFolder(importer: () => Promise<unknown>) {
        const previousNames = new Set((DBState.db.plugins ?? []).map((plugin) => plugin.name))
        await importer()
        for (const plugin of DBState.db.plugins ?? []) {
            if (!previousNames.has(plugin.name)) assignPluginToFolder(plugin.name, selectedPluginFolder)
        }
    }
</script>

<SettingPage title={language.plugin}>
<span class="text-draculared text-xs mb-4">{language.pluginWarn}</span>

<CollectionOrganizerList
    kind="plugins"
    items={organizerPluginItems}
    collectionLabel={language.plugin}
    bind:selectedFolderId={selectedPluginFolder}
>
    {#snippet toolbar(_selectedFolderId)}
        <div class="flex items-center gap-1 text-textcolor2">
            <ShButton variant="ghost" size="icon-sm" aria-label={language.import} onclick={() => importPluginsToSelectedFolder(() => importPlugin())}><PlusIcon /></ShButton>
            <ShButton variant="ghost" size="icon-sm" aria-label="Plugin developer tools" onclick={async () => {
                const v = parseInt(await alertSelect([
                    'Import plugin with hot reload',
                    'Download plugin template',
                    language.cancel,
                ]))
                if (v === 0) await importPluginsToSelectedFolder(hotReloadPluginFiles)
                if (v === 1) {
                    const a = document.createElement('a')
                    a.href = '/plugin_start.7z'
                    a.download = 'plugin_starter.7z'
                    document.body.appendChild(a)
                    a.click()
                    a.remove()
                }
            }}><CodeXmlIcon /></ShButton>
        </div>
    {/snippet}

    {#snippet itemContent(pluginName)}
        {@const i = (DBState.db.plugins ?? []).findIndex((plugin) => plugin.name === pluginName)}
        {#if i >= 0}
            {@const plugin = DBState.db.plugins[i]}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="flex gap-2" aria-labelledby="show-params" role='button' tabindex="0" onclick={() => {
            if(showParams.includes(plugin.name)){
                showParams.splice(showParams.indexOf(plugin.name),1)
            }
            else{
                showParams.push(plugin.name)
            }
            showParams = showParams
        }}>
            <div class="font-bold grow">
                <span>
                    {plugin.displayName ?? plugin.name}
                </span>
                {#if hotReloading.includes(plugin.name)}
                    <span class="text-sm rounded bg-amber-700 ml-2 px-2 py-1 text-white">
                        Hot
                    </span>
                {/if}
            </div>
            {#if plugin.version === 2 || plugin.version === "2.1"}
                <button class="text-yellow-400 hover:gray-200 cursor-pointer" onclick={(e) => {
                    e.stopPropagation()
                    alertMd(language.pluginV2Warning);
                }} >
                    <TriangleAlert />
                </button>
            {/if}

            {#if plugin.customLink}
                {#each plugin.customLink as link}
                    {#if typeof link.link === "string" && (link.link.startsWith("http://") || link.link.startsWith("https://"))}
                        <a
                            href={link.link}
                            target="_blank"
                            rel="nofollow noopener noreferrer"
                            class="text-textcolor2 hover:text-textcolor cursor-pointer"
                            title={link.hoverText}
                            onclick={(e) => e.stopPropagation()}
                        >
                            <LinkIcon></LinkIcon>
                        </a>
                    {/if}
                {/each}
            {/if}

            {#if plugin.updateURL}
                {#await checkPluginUpdate(plugin) then updateInfo}
                    {#if updateInfo}
                        <button
                            class="text-green-400 hover:gray-200 cursor-pointer"
                            disabled={updatingPlugins.includes(plugin.name)}
                            onclick={async (e) => {
                                e.stopPropagation()
                                const v = await alertConfirm(
                                    language.pluginUpdateFoundInstallIt
                                );
                                if (v) {
                                    await installPluginUpdate(plugin)
                                }
                            }}
                        >
                            <PlusIcon />
                        </button>
                    {/if}
                {/await}
            {/if}

            <button
                class="textcolor2 hover:gray-200 cursor-pointer"
                onclick={async (e) => {
                    e.stopPropagation()
                    plugin.enabled = !plugin.enabled
                    DBState.db.plugins[i] = plugin
                    loadPlugins()
                    void requestImmediateSave()
                    e.preventDefault()
                }}
            >
                {#if plugin.enabled}
                    <PowerIcon />
                {:else}
                    <PowerOffIcon />
                {/if}
            </button>

            <button
                class="textcolor2 hover:text-primary cursor-pointer"
                title={language.resetPluginPermission}
                onclick={async (e) => {
                    e.stopPropagation()
                    const v = await alertConfirm(
                        language.resetPluginPermissionConfirm.replace("{}", plugin.displayName ?? plugin.name)
                    )
                    if (v) {
                        await resetPluginPermission(plugin.name)
                        notifySuccess(language.resetPluginPermissionDone.replace("{}", plugin.displayName ?? plugin.name))
                    }
                }}
            >
                <ShieldIcon />
            </button>

            <!--Also, remove button.-->
            <button
                class="textcolor2 hover:gray-200 cursor-pointer"
                onclick={async (e) => {
                    e.stopPropagation()
                    const v = await alertConfirm(
                        language.removeConfirm +
                            (plugin.displayName ?? plugin.name),
                    );
                    if (v) {
                        if (DBState.db.currentPluginProvider === plugin.name) {
                            DBState.db.currentPluginProvider = "";
                        }
                        let plugins = DBState.db.plugins ?? [];
                        plugins.splice(i, 1);
                        DBState.db.plugins = plugins;
                        loadPlugins()
                        void requestImmediateSave()
                    }
                }}
            >
                <TrashIcon />
            </button>
        </div>
        {#if plugin.version === 1}
            <span class="text-draculared text-xs">
                {language.pluginVersionWarn
                    .replace("{{plugin_version}}", "API V1")
                    .replace("{{required_version}}", "API V3")}
            </span>
            <!--List up args-->
        {:else if Object.keys(plugin.arguments).filter((i) => !i.startsWith("hidden_")).length > 0 && showParams.includes(plugin.name)}
            <div class="flex flex-col mt-2 bg-dark-900/50 p-3">
                {#each Object.keys(plugin.arguments) as arg}
                    {#if !arg.startsWith("hidden_")}
                        {#if typeof(plugin?.argMeta?.[arg]?.divider) === 'string'}
                            {#if plugin?.argMeta?.[arg]?.divider}
                                <div class="flex items-center mt-6">
                                    <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                    <div class="relative flex justify-center">
                                        <span class="px-2 text-sm text-textarea text-nowrap">{plugin?.argMeta?.[arg]?.divider}</span>
                                    </div>
                                    <div aria-hidden="true" class="w-full border-t border-darkborderc"></div>
                                </div>
                            {:else}
                                <div aria-hidden="true" class="w-full border-t border-darkborderc mt-6"></div>
                            {/if}
                        {/if}
                        <span class="mb-2 mt-6">{plugin?.argMeta?.[arg]?.name || arg}</span>
                        {#if plugin?.argMeta?.[arg]?.description}
                            <span class="mb-2 text-sm text-textcolor2">{plugin?.argMeta?.[arg]?.description}</span>
                        {/if}
                        {#if Array.isArray(plugin.arguments[arg])}
                            <SelectInput
                                className="mt-2 mb-4"
                                bind:value={
                                    DBState.db.plugins[i].realArg[arg] as string
                                }
                            >
                                {#each plugin.arguments[arg] as a}
                                    <OptionInput value={a}>{a}</OptionInput>
                                {/each}
                            </SelectInput>
                        {:else if plugin.arguments[arg] === "string"}

                            {#if plugin?.argMeta?.[arg]?.textarea}
                                <TextAreaInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[i].realArg[arg] as string
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {:else if plugin?.argMeta?.[arg]?.radio}
                                {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                    <CheckInput
                                        check={DBState.db.plugins[i].realArg[arg] === (radioOption.split('|').at(-1))}
                                        onChange={(e) => {
                                            if(e){
                                                DBState.db.plugins[i].realArg[arg] = (radioOption.split('|').at(-1))
                                            }
                                        }}
                                        margin={false}
                                        name={radioOption.split('|').at(0)}
                                    />
                                {/each}
                            {:else}
                                <TextInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[i].realArg[arg] as string
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {/if}
                        {:else if plugin.arguments[arg] === "int"}
                            {#if plugin?.argMeta?.[arg]?.checkbox}
                                <CheckInput
                                    check={DBState.db.plugins[i].realArg[arg] === '1'}
                                    onChange={(e) => {
                                        DBState.db.plugins[i].realArg[arg] = e ? '1' : '0'
                                    }}
                                    margin={false}
                                    name={
                                        plugin?.argMeta?.[arg]?.checkbox === '1' ? language.enable : plugin?.argMeta?.[arg]?.checkbox
                                    }
                                />
                            {:else if plugin?.argMeta?.[arg]?.radio}
                                {#each plugin?.argMeta?.[arg]?.radio?.split(",") as radioOption}
                                    <CheckInput
                                        check={DBState.db.plugins[i].realArg[arg] === parseInt(radioOption.split('|').at(-1))}
                                        onChange={(e) => {
                                            if(e){
                                                DBState.db.plugins[i].realArg[arg] = parseInt(radioOption.split('|').at(-1))
                                            }
                                        }}
                                        margin={false}
                                        name={radioOption.split('|').at(0)}
                                    />
                                {/each}
                            {:else}
                                <NumberInput
                                    className="mt-2"
                                    bind:value={
                                        DBState.db.plugins[i].realArg[arg] as number
                                    }
                                    placeholder={plugin?.argMeta?.[arg]?.placeholder}
                                />
                            {/if}
                        {/if}
                    {/if}
                {/each}
            </div>
        {/if}
        {/if}
    {/snippet}
</CollectionOrganizerList>
</SettingPage>
