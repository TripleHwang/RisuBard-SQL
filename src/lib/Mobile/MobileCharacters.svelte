<script lang="ts">
    import { type character } from "src/ts/storage/database.svelte";
    import { DBState } from 'src/ts/stores.svelte';
    import BarIcon from "../SideBars/BarIcon.svelte";
    import { addCharacter, changeChar, getCharImage } from "src/ts/characters";
    import { makeAgoText } from "src/ts/util";
    import { MessageSquareIcon, PlusIcon } from "@lucide/svelte";
    import { isNodeServer } from "src/ts/platform";
    import { getAssetUrl } from "src/ts/media/assetUrl";
    import VirtualCharacterList from "../UI/VirtualCharacterList.svelte";
    import LazyState from "../UI/GUI/LazyState.svelte";
    import { createCharacterOpener } from "src/ts/characterOpen.svelte";
    import { language } from "src/lang";

    interface Props {
        search: string;
        gridMode?: boolean;
        endGrid?: () => void;
    }

    let {search, gridMode = false, endGrid = () => {}}: Props = $props();

    function sortChar(char: (character)[]) {
        return char.map((c, i) => ({
                name: c.name || "Unnamed",
                image: c.image,
                chaId: c.chaId,
                chats: c.chats.length,
                i: i,
                type: c.type,
                interaction: c.lastInteraction || 0,
                agoText: makeAgoText(c.lastInteraction || 0),
                trashTime: c.trashTime,
            })).filter((c) => !c.trashTime).sort((a, b) => {
            if (a.interaction === b.interaction) {
                return a.name.localeCompare(b.name);
            }
            return b.interaction - a.interaction;
        });
    }

    let characters = $derived(sortChar(DBState.db.characters).filter((char) =>
        char.name.replace(/ /g, "").toLocaleLowerCase().includes(search.replace(/ /g, "").toLocaleLowerCase())
    ));

    function thumbSource(image: string) {
        return getAssetUrl(image, { variant: 'thumbnail', node: isNodeServer });
    }

    function fullSource(image: string) {
        return getAssetUrl(image, { variant: 'full', node: isNodeServer });
    }

    /**
     * The list closes onto the character only once that character is really
     * loaded, and the progress and any failure stay in this list. The old path
     * called `changeChar` straight from the row, which raised the app-wide
     * `fixed inset-0` overlay and then closed the list whether or not the
     * character had been read.
     */
    const opener = createCharacterOpener((index) => {
        void changeChar(index)
        endGrid()
    })
</script>
<div class="flex flex-col items-center w-full h-full">
    <LazyState resource={opener.resource}>
        {#snippet loading()}
            <div role="status" aria-live="polite" class="w-full px-2 py-1 text-sm text-textcolor2">
                {language.lazyLoad.loading}{opener.openingName ? ` · ${opener.openingName}` : ''}
            </div>
        {/snippet}
        {#snippet failed()}
            <div role="alert" class="m-2 flex w-full flex-col gap-1 rounded-lg border border-danger-border bg-danger-bg p-2 text-sm text-danger">
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
    <VirtualCharacterList count={characters.length} itemsSignature={characters.map((char) => char.chaId).join('|')} rowHeight={68} overscan={8} getKey={(index) => characters[index].chaId}>
        {#snippet children(index, focusedIndex, chaId)}
            {@const char = characters[index]}
            <button id={`virtual-character-${chaId}`} role="option" aria-selected={focusedIndex === index} data-virtual-index={index} tabindex={focusedIndex === index ? 0 : -1} class="flex p-2 border-t-darkborderc gap-2 w-full h-[68px]" class:border-t={index !== 0} onclick={() => opener.open(char.i)}>
                {#if thumbSource(char.image)}
                    <img class="w-12 h-12 rounded object-cover" src={thumbSource(char.image)} alt="" loading="lazy" decoding="async" onerror={(event) => {
                        const image = event.currentTarget as HTMLImageElement
                        const full = fullSource(char.image)
                        if (full && image.src !== new URL(full, window.location.href).href) image.src = full
                    }} />
                {:else}
                    <BarIcon additionalStyle={getCharImage(char.image, 'css')}></BarIcon>
                {/if}
                <div class="flex flex-1 w-full flex-col justify-start items-start text-start">
                    <span>{char.name}</span>
                    <div class="text-sm text-textcolor2 flex items-center w-full flex-wrap">
                        <span class="mr-1">{char.chats}</span>
                        <MessageSquareIcon size={14} />
                        <span class="mr-1 ml-1">|</span>
                        <span>{char.agoText}</span>
                    </div>
                </div>
            </button>
        {/snippet}
    </VirtualCharacterList>
</div>

{#if gridMode}
    <button class="p-4 rounded-full absolute bottom-2 right-2 bg-borderc" onclick={() => {
        addCharacter()
    }}>
        <PlusIcon size={24} />
    </button>
{/if}
