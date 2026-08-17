<script lang="ts">
    import { ChevronRightIcon } from "@lucide/svelte";

    interface Props {
        label: string;
        activeName: string;
        onManage: () => void;
    }

    let {
        label,
        activeName,
        onManage,
    }: Props = $props();

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onManage();
        }
    }
</script>

<div
    data-settings-preset-header
    role="button"
    tabindex="0"
    aria-label={`${label}: ${activeName}`}
    onclick={onManage}
    onkeydown={handleKeydown}
    class="settings-preset-header w-full flex items-center gap-3 px-4 py-3 mb-5 cursor-pointer transition-colors"
>
    <div class="flex flex-col min-w-0 grow">
        <span class="text-xs text-textcolor2">{label}</span>
        <span class="text-sm text-textcolor truncate">{activeName}</span>
    </div>
    <ChevronRightIcon size={18} class="shrink-0 text-textcolor2" />
</div>

<style>
    .settings-preset-header {
        border: 1px solid var(--settings-border, var(--risu-theme-darkborderc));
        border-radius: var(--settings-radius, .75rem);
        background: var(--settings-surface, var(--risu-theme-darkbg));
    }

    .settings-preset-header:hover {
        background: var(--settings-surface-hover, var(--risu-theme-selected));
    }
</style>
