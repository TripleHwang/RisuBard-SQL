<script lang="ts">
    import { DBState } from "src/ts/stores.svelte";
    import RegexList from "src/lib/SideBars/Scripts/RegexList.svelte";
    import type { botPreset } from "src/ts/storage/database.svelte";

    let { getPreset }: { getPreset?: () => botPreset | null | undefined } = $props();
    let settings = $derived.by(() => {
        const scoped = getPreset?.();
        if (scoped) scoped.regex ??= [];
        return scoped;
    });
</script>

{#if settings}
    <RegexList bind:value={settings.regex} buttons />
{:else}
    <RegexList bind:value={DBState.db.presetRegex} buttons />
{/if}
