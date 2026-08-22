<script lang="ts">
    import { languageSettingsItems, langState } from "src/ts/setting/languageSettingsData.svelte";
    import SettingRenderer from "../SettingRenderer.svelte";
    import SettingPage from "src/lib/UI/GUI/SettingPage.svelte";
    import { language } from "src/lang";
    import { onMount } from "svelte";
    import { DBState } from "src/ts/stores.svelte";
    import TranslationCacheManager from "./Language/TranslationCacheManager.svelte";

    let { embedded = false }: { embedded?: boolean } = $props();

    onMount(() => {
        langState.changed = false;
    });
</script>

<SettingPage title={language.language} showTitle={!embedded}>
<SettingRenderer items={languageSettingsItems} />
{#if DBState.db.translator && DBState.db.translatorType === 'llm'}
    <TranslationCacheManager />
{/if}
</SettingPage>
