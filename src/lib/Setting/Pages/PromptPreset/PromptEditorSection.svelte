<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import TextAreaInput from "src/lib/UI/GUI/TextAreaInput.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import DropList from "src/lib/SideBars/DropList.svelte";
    import PromptSettings from "../PromptSettings.svelte";
    import type { botPreset } from "src/ts/storage/database.svelte";

    let { getPreset }: { getPreset?: () => botPreset | null | undefined } = $props();
    let settings = $derived(getPreset?.() ?? DBState.db);
</script>

{#if !settings.promptTemplate}
    <span class="text-textcolor">{language.mainPrompt} <Help key="mainprompt"/></span>
    <TextAreaInput className="mt-2 mb-4" fullwidth autocomplete="off" height={"32"} bind:value={settings.mainPrompt}></TextAreaInput>
    <span class="text-textcolor">{language.jailbreakPrompt} <Help key="jailbreak"/></span>
    <TextAreaInput className="mt-2 mb-4" fullwidth autocomplete="off" height={"32"} bind:value={settings.jailbreak}></TextAreaInput>
    <span class="text-textcolor">{language.globalNote} <Help key="globalNote"/></span>
    <TextAreaInput className="mt-2 mb-4" fullwidth autocomplete="off" height={"32"} bind:value={settings.globalNote}></TextAreaInput>
    <span class="text-textcolor mb-2 mt-4">{language.formatingOrder} <Help key="formatOrder"/></span>
    <DropList bind:list={settings.formatingOrder} />
    <div class="flex items-center mt-4">
        <Check bind:check={settings.promptPreprocess} name={language.promptPreprocess}/>
        <Help key="promptPreprocess"/>
    </div>
{:else}
    <PromptSettings mode='inline' {getPreset} />
{/if}
