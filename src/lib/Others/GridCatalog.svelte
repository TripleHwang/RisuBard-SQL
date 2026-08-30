<script lang="ts">
    import { changeChar, getCharImage, removeChar } from "../../ts/characters";
    import { type Database } from "../../ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import { findCharacterIndexbyId } from "../../ts/util";
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { ArrowLeft, User, SquareMousePointer, TrashIcon, Undo2Icon } from "@lucide/svelte";
    import { selectedCharID } from "../../ts/stores.svelte";
    import TextInput from "../UI/GUI/TextInput.svelte";
    import Button from "../UI/GUI/Button.svelte";
    import { language } from "src/lang";
    import { parseMultilangString } from "src/ts/util";
    import { checkCharOrder } from "src/ts/globalApi.svelte";
    import LazyState from "../UI/GUI/LazyState.svelte";
    import { createCharacterOpener } from "src/ts/characterOpen.svelte";
  import MobileCharacters from "../Mobile/MobileCharacters.svelte";
    interface Props {
        endGrid?: any;
    }

    let { endGrid = () => {} }: Props = $props();
    let search = $state('')
    let selected = $state(3)

    /**
     * Same rule as the sidebar: the character is loaded before the catalog
     * closes onto it, with the progress and any failure shown here rather than
     * behind the app-wide overlay `changeChar` used to raise. Closing on a
     * failed load would drop the user on a screen rendering a character nobody
     * managed to read.
     */
    const opener = createCharacterOpener((index) => {
        void changeChar(index)
        endGrid()
    })

    function selectAndClose(index = -1){
        if(index < 0) return
        opener.open(index)
    }

    function formatChars(search:string, db:Database, trash = false){
        let charas:{
            image:string
            index:number
            type:string,
            name:string
            desc:string
            chaId:string
        }[] = []

        for(let i=0;i<db.characters.length;i++){
            const c = db.characters[i]
            if(c.trashTime && !trash){
                continue
            }
            if(!c.trashTime && trash){
                continue
            }
            if(c.name.replace(/ /g,"").toLocaleLowerCase().includes(search.toLocaleLowerCase().replace(/ /g,""))){
                charas.push({
                    image: c.image,
                    index: i,
                    type: c.type,
                    name: c.name,
                    desc: c.creatorNotes ?? 'No description',
                    chaId: c.chaId
                })
            }
        }
        return charas
    }
</script>

<div class="h-full w-full flex justify-center">
    <div class="h-full min-h-0 p-6 bg-darkbg max-w-full w-2xl flex flex-col">
        <div class="mx-4 mb-6 flex flex-col shrink-0">
            <div class="flex items-center gap-3 mb-2">
                <button 
                    class="flex items-center justify-center p-2 rounded-lg hover:bg-selected transition-colors shrink-0"
                    onclick={() => endGrid()}
                    title="Back"
                >
                    <ArrowLeft size={20} />
                </button>
                <div class="flex-1">
                    <TextInput placeholder="Search" bind:value={search} autocomplete="off" fullwidth={true}/>
                </div>
            </div>
            <div class="flex flex-wrap gap-2 mt-2">
                <Button styled={selected === 3 ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 3}}>
                    {language.simple}
                </Button>
                <Button styled={selected === 0 ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 0}}>
                    {language.grid}
                </Button>
                <Button styled={selected === 1  ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 1}}>
                    {language.list}
                </Button>
                <Button styled={selected === 2  ? 'primary' : 'outlined'} size="sm" onclick={() => {selected = 2}}>
                    {language.trash}
                </Button>
                <div class="grow"></div>
                <span class="text-textcolor2 text-sm">
                    {formatChars(search, DBState.db).length} {language.character}
                </span>
            </div>
        </div>
        <LazyState resource={opener.resource}>
            {#snippet loading()}
                <div role="status" aria-live="polite" class="mx-4 mb-2 text-sm text-textcolor2">
                    {language.lazyLoad.loading}{opener.openingName ? ` · ${opener.openingName}` : ''}
                </div>
            {/snippet}
            {#snippet failed()}
                <div role="alert" class="mx-4 mb-2 flex flex-col gap-1 rounded-lg border border-danger-border bg-danger-bg p-2 text-sm text-danger">
                    <span class="font-medium">{language.lazyLoad.characterFailed}{opener.openingName ? `: ${opener.openingName}` : ''}</span>
                    {#if opener.resource.errorMessage}
                        <span class="break-all text-xs opacity-70">{opener.resource.errorMessage}</span>
                    {/if}
                    <button type="button" class="self-start rounded border border-danger-border px-2 py-0.5 text-xs transition-colors hover:bg-danger/15" onclick={() => opener.retryCurrent()}>
                        {language.lazyLoad.retry}
                    </button>
                </div>
            {/snippet}
        </LazyState>
        <div class="flex-1 min-h-0" class:overflow-y-auto={selected !== 3}>
        {#if selected === 0}
            <div class="w-full flex justify-center">
                <div class="flex flex-wrap gap-2 w-full justify-center">
                    {#each formatChars(search, DBState.db) as char}
                        <div class="flex items-center text-textcolor">
                            {#if char.image}
                                <BarIcon onClick={() => {selectAndClose(char.index)}} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                            {:else}
                                <BarIcon onClick={() => {selectAndClose(char.index)}} additionalStyle={char.index === $selectedCharID ? 'background:var(--risu-theme-selected)' : ''}>
                                            <User/>
                                </BarIcon>
                            {/if}
                        </div>
                    {/each}
                </div>
            </div>
        {:else if selected === 1}
            {#each formatChars(search, DBState.db) as char}
                <div class="flex p-2 border border-darkborderc rounded-md mb-2">
                    <BarIcon onClick={() => {selectAndClose(char.index)}} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="text-textcolor font-bold text-lg mb-1">{char.name || "Unnamed"}</h4>
                        <span class="text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="flex gap-2 justify-end">
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                selectAndClose(char.index)
                            }}>
                                <SquareMousePointer />
                            </button>
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                removeChar(char.chaId, char.name)
                            }}>
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
            {/each}
        {:else if selected === 2}
            <span class="text-textcolor2 text-sm mb-2">{language.trashDesc}</span>
            {#each formatChars(search, DBState.db, true) as char}
                <div class="flex p-2 border border-darkborderc rounded-md mb-2">
                    <BarIcon onClick={() => {selectAndClose(char.index)}} additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                    <div class="flex-1 flex flex-col ml-2">
                        <h4 class="text-textcolor font-bold text-lg mb-1">{char.name || "Unnamed"}</h4>
                        <span class="text-textcolor2">{parseMultilangString(char.desc)['en'] || parseMultilangString(char.desc)['xx'] || 'No description'}</span>
                        <div class="flex gap-2 justify-end">
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                const restoreIdx = findCharacterIndexbyId(char.chaId)
                                if (restoreIdx !== -1) {
                                    DBState.db.characters[restoreIdx].trashTime = undefined
                                    checkCharOrder()
                                }
                            }}>
                                <Undo2Icon />
                            </button>
                            <button class="hover:text-textcolor text-textcolor2" onclick={() => {
                                removeChar(char.chaId, char.name, 'permanent')
                            }}>
                                <TrashIcon />
                            </button>
                        </div>
                    </div>
                </div>
            {/each}
        {:else if selected === 3}
            <!-- Task 7 scope: only Simple (selected === 3) is virtualized; Grid, List, and Trash remain follow-up work. -->
            <MobileCharacters {search} gridMode endGrid={endGrid} />
        {/if}
        </div>
    </div>
</div>
