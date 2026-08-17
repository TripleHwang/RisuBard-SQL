<script lang="ts">
    import { language } from "src/lang";
    import TextInput from "src/lib/UI/GUI/TextInput.svelte";
    import type { loreBook } from "src/ts/storage/database.svelte";
    import LoreBookWorkspaceDialog from "src/lib/SideBars/LoreBook/LoreBookWorkspaceDialog.svelte";
    import {
        coreLorebookScopeKey,
        createLorebookOwnerBinding,
        importLorebooksIntoModule,
    } from "src/lib/SideBars/LoreBook/loreBookWorkspaceConnections";
    import { type CCLorebook, convertExternalLorebook } from "src/ts/process/lorebook.svelte";
    import type { RisuModule } from "src/ts/process/modules";
    import { DownloadIcon, HardDriveUploadIcon, ImageIcon, PlusIcon, TrashIcon } from "@lucide/svelte";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import TriggerList from "src/lib/SideBars/Scripts/TriggerList.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import { getFileSrc, saveAsset, downloadFile } from "src/ts/globalApi.svelte";
    import { alertError, notifySuccess } from "src/ts/alert";
    import { exportRegex, importRegex } from "src/ts/process/scripts";
    import { selectMultipleFile } from "src/ts/util";
    import { openAssetViewer, hasImageAssets } from "src/ts/assetViewer.svelte";
    import ShButton from "src/lib/UI/GUI/ShButton.svelte";
    
    import { DBState } from 'src/ts/stores.svelte';

    let submenu = $state(0)
    interface Props {
        currentModule: RisuModule;
    }

    let { currentModule = $bindable() }: Props = $props();
    let assetFileExtensions:string[] = $state([])
    let assetFilePath:string[] = $state([])
    let workspaceOpen = $state(false)
    let activeBinding = $derived.by(() => {
        const owner = currentModule
        return {
            ...createLorebookOwnerBinding(
                owner,
                owner.lorebook ?? [],
                (owner, next) => { owner.lorebook = next },
            ),
            scopeKey: coreLorebookScopeKey({
                kind: 'module',
                moduleId: owner.id,
            }),
            scopeLabel: `${language.module} · ${owner.name}`,
        }
    })

    $effect.pre(() => {
        if(DBState.db.useAdditionalAssetsPreview){
            if(currentModule?.assets){
                for(let i = 0; i < currentModule.assets.length; i++){
                    if(currentModule.assets[i].length > 2 && currentModule.assets[i][2]) {
                        assetFileExtensions[i] = currentModule.assets[i][2]
                    } else 
                        assetFileExtensions[i] = currentModule.assets[i][1].split('.').pop()
                        getFileSrc(currentModule.assets[i][1]).then((filePath) => {
                        assetFilePath[i] = filePath
                    })
                }
            }
        }
    });

    async function exportLoreBook(){
        try {
            const lore = currentModule.lorebook        
            const stringl = Buffer.from(JSON.stringify({
                type: 'risu',
                ver: 1,
                data: lore
            }), 'utf-8')

            await downloadFile(`lorebook_export.json`, stringl)

            notifySuccess(language.successExport)
        } catch (error) {
            alertError(`${error}`)
        }
    }

    async function importLoreBook(){
        const targetModule = currentModule
        try {
            await importLorebooksIntoModule(
                targetModule,
                () => currentModule,
                () => selectMultipleFile(['json', 'lorebook']),
                (data) => {
                    const importedEntries: loreBook[] = []
                    const importedlore = JSON.parse(Buffer.from(data).toString('utf-8'))
                    if(importedlore.type === 'risu' && importedlore.data){
                        importedEntries.push(...importedlore.data as loreBook[])
                    }
                    else if(importedlore.entries){
                        const entries:{[key:string]:CCLorebook} = importedlore.entries
                        importedEntries.push(...convertExternalLorebook(entries))
                    }
                    return importedEntries
                },
            )
        } catch (error) {
            alertError(`${error}`)
        }
    }

    function addRegex(){
        if(Array.isArray(currentModule.regex)){
            currentModule.regex.push({
                comment: "",
                in: "",
                out: "",
                type: "editinput"
            })

            currentModule.regex = currentModule.regex
        }
    }

    function addTrigger(){
        if(Array.isArray(currentModule.trigger)){
            currentModule.trigger.push({
                conditions: [],
                type: 'start',
                comment: '',
                effect: []
            })

            currentModule.trigger = currentModule.trigger
        }
    }
</script>

<div class="flex w-full rounded-md border border-darkborderc mb-4 overflow-x-auto h-16 min-h-16 overflow-y-clip">
    <button onclick={() => {
        submenu = 0
    }} class="p-2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 0}>
        <span>{language.basicInfo}</span>
    </button>
    <button onclick={() => {
        currentModule.lorebook ??= []
        submenu = 1
    }} class="p2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 1}>
        <span>{language.loreBook}</span>
    </button>
    <button onclick={() => {
        currentModule.regex ??= []
        submenu = 2
    }} class="p-2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 2}>
        <span>{language.regexScript}</span>
    </button>
    <button onclick={() => {
        currentModule.trigger ??= [{
            comment: "",
            type: "manual",
            conditions: [],
            effect: [{
                type: "v2Header",
                code: "",
                indent: 0
            }]
        }, {
            comment: "New Event",
            type: 'manual',
            conditions: [],
            effect: []
        }]
        submenu = 3
    }} class="p-2 flex-1 border-r border-darkborderc" class:bg-darkbutton={submenu === 3}>
        <span>{language.triggerScript}</span>
    </button>
    <button onclick={() => {
        currentModule.assets ??= []
        submenu = 5
    }} class="p-2 flex-1" class:bg-darkbutton={submenu === 5}>
        <span>{language.additionalAssets}</span>
    </button>
</div>

{#if submenu === 0}
    <span>{language.name} <Help key="moduleName" /></span>
    <TextInput bind:value={currentModule.name} className="mt-2"/>
    <span class="mt-4">{language.description} <Help key="moduleDescription" /></span>
    <TextInput bind:value={currentModule.description} className="mt-2"/>
    <span class="mt-4">{language.namespace} <Help key="namespace" /></span>
    <TextInput bind:value={currentModule.namespace} className="mt-2"/>
    <div class="flex items-center mt-4">
        <Check bind:check={currentModule.hideIcon} name={language.hideChatIcon}/>
        <Help key="moduleHideChatIcon" />
    </div>
    <span class="mt-4">{language.customPromptTemplateToggle} <Help key='customPromptTemplateToggle' /></span>
    <TextAreaInput className="mt-2 mb-4" bind:value={currentModule.customModuleToggle}/>
{/if}
{#if submenu === 1 && (Array.isArray(currentModule.lorebook))}
    <button
        data-lorebook-workspace-open
        class="w-full rounded-md border border-selected bg-darkbg p-3 text-left text-textcolor hover:bg-selected"
        aria-label={language.lorebookWorkspace.openScope(activeBinding.scopeLabel)}
        title={language.lorebookWorkspace.open}
        onclick={() => { workspaceOpen = true }}
    >
        <strong>{activeBinding.scopeLabel}</strong>
        <span class="ml-2 text-sm text-textcolor2">{language.lorebookWorkspace.entriesCount(currentModule.lorebook.length)}</span>
    </button>
    <LoreBookWorkspaceDialog
        bind:open={workspaceOpen}
        entries={activeBinding.entries}
        scopeKey={activeBinding.scopeKey}
        scopeLabel={activeBinding.scopeLabel}
        onChange={activeBinding.onChange}
        onImport={importLoreBook}
        onExport={exportLoreBook}
    />
{/if}

{#if submenu === 2 && (Array.isArray(currentModule.regex))}
    <span class="mt-2 flex items-center">{language.backgroundHTML} <Help key="moduleBackgroundEmbedding" /></span>
    <TextAreaInput bind:value={currentModule.backgroundEmbedding} className="mt-2" placeholder={language.backgroundHTML}/>
    <span class="mt-4 flex items-center">{language.regexScript} <Help key="moduleRegexList" /></span>
    <RegexList bind:value={currentModule.regex}/>
    <div class="text-textcolor2 mt-2 flex gap-2">
        <button class="font-medium cursor-pointer hover:text-primary" onclick={() => {
            addRegex()
        }}><PlusIcon /></button>
        <button class="font-medium cursor-pointer hover:text-primary" onclick={() => {
            exportRegex(currentModule.regex)
        }}><DownloadIcon /></button>
        <button class="font-medium cursor-pointer hover:text-primary" onclick={async () => {
            currentModule.regex = await importRegex(currentModule.regex)
        }}><HardDriveUploadIcon /></button>
    </div>
{/if}

{#if submenu === 5 && (Array.isArray(currentModule.assets))}
    {#if hasImageAssets(currentModule.assets)}
        <ShButton
            className="w-full mb-3"
            onclick={() => openAssetViewer(currentModule.name, currentModule.assets)}
        >
            <ImageIcon size={16} />
            <span>{language.viewInAssetViewer}</span>
        </ShButton>
    {/if}
    <span class="mb-2 flex items-center">{language.additionalAssets} <Help key="moduleAdditionalAssets" /></span>
    <div class="w-full max-w-full border border-selected rounded-md p-2">
        <table class="contain w-full max-w-full tabler mt-2">
            <tbody>
            <tr>
                <th class="font-medium">{language.value}</th>
                <th class="font-medium cursor-pointer w-10">
                    <button class="hover:text-primary" onclick={async () => {
                        const da = await selectMultipleFile(['png', 'webp', 'mp4', 'mp3', 'gif', 'jpeg', 'jpg', 'ttf', 'otf', 'css', 'webm', 'woff', 'woff2', 'svg', 'avif'])
                        currentModule.assets = currentModule.assets ?? []
                        if(!da){
                            return
                        }
                        for(const f of da){
                            const img = f.data
                            const name = f.name
                            const extension = name.split('.').pop().toLowerCase()
                            const imgp = await saveAsset(img,'', extension)
                            currentModule.assets.push([name, imgp, extension])
                            currentModule.assets = currentModule.assets
                        }
                    }}>
                        <PlusIcon />
                    </button>
                </th>
            </tr>
            {#if (!currentModule.assets) || currentModule.assets.length === 0}
                <tr>
                    <td colspan="3">{language.noData}</td>
                </tr>
            {:else}
                {#each currentModule.assets as assets, i}
                    <tr>
                        <td class="font-medium truncate">
                            {#if assetFilePath[i] && DBState.db.useAdditionalAssetsPreview}
                                {#if assetFileExtensions[i] === 'mp4'}
                                <!-- svelte-ignore a11y_media_has_caption -->
                                    <video controls class="mt-2 px-2 w-full m-1 rounded-md"><source src={assetFilePath[i]} type="video/mp4"></video>
                                {:else if assetFileExtensions[i] === 'mp3'}
                                    <audio controls class="mt-2 px-2 w-full h-16 m-1 rounded-md" loop><source src={assetFilePath[i]} type="audio/mpeg"></audio>
                                {:else}
                                    <img src={assetFilePath[i]} class="w-16 h-16 m-1 rounded-md" alt={assets[0]}/>
                                {/if}
                            {/if}
                            <TextInput fullwidth marginBottom bind:value={currentModule.assets[i][0]} placeholder="..." />
                        </td>
                        
                        <th class="font-medium cursor-pointer w-10">
                            <button class="hover:text-red-400" onclick={() => {
                                let additionalAssets = currentModule.assets
                                additionalAssets.splice(i, 1)
                                currentModule.assets = additionalAssets
                            }}>
                                <TrashIcon />
                            </button>
                        </th>
                    </tr>
                {/each}
            {/if}
            </tbody>
        </table>
    </div>
{/if}

{#if submenu === 3 && (Array.isArray(currentModule.trigger))}
    <TriggerList bind:value={currentModule.trigger} lowLevelAble={currentModule.lowLevelAccess} />

    <div class="flex items-center mt-4">
        <Check bind:check={currentModule.lowLevelAccess} name={language.lowLevelAccess}/>
        <span> <Help key="lowLevelAccess" name={language.lowLevelAccess}/></span>
    </div>
{/if}
