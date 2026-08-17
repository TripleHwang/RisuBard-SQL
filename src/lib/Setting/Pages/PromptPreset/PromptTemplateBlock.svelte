<script lang="ts">
    import { language } from "src/lang";
    import { DBState } from "src/ts/stores.svelte";
    import Check from "src/lib/UI/GUI/CheckInput.svelte";
    import Help from "src/lib/Others/Help.svelte";
    import PromptSettings from "../PromptSettings.svelte";
    import type { botPreset } from "src/ts/storage/database.svelte";

    let { getPreset }: { getPreset?: () => botPreset | null | undefined } = $props();
    let settings = $derived(getPreset?.() ?? DBState.db);
</script>

{#if settings.promptTemplate}
    <PromptSettings mode='inline' subMenu={1} {getPreset} />
{:else}
    <div class="flex items-center">
        <Check check={false} name={language.usePromptTemplate} onChange={() => {
            settings.promptTemplate = [];
        }}/>
        <Help key="usePromptTemplate"/>
    </div>
{/if}
