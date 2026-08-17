<script lang="ts">
    export interface SettingsSectionTab {
        label: string
        value: number
    }

    interface Props {
        tabs: SettingsSectionTab[]
        selected: number
        onSelect: (value: number) => void
        ariaLabel?: string
        class?: string
    }

    let {
        tabs,
        selected,
        onSelect,
        ariaLabel,
        class: className = '',
    }: Props = $props()
</script>

<div
    data-settings-section-tabs
    class="settings-section-tabs {className}"
    role="tablist"
    aria-label={ariaLabel}
>
    {#each tabs as tab (tab.value)}
        <button
            role="tab"
            aria-selected={selected === tab.value}
            class:active={selected === tab.value}
            onclick={() => onSelect(tab.value)}
        >
            <span>{tab.label}</span>
        </button>
    {/each}
</div>

<style>
    .settings-section-tabs {
        width: 100%;
        display: flex;
        overflow-x: auto;
        overflow-y: hidden;
        margin-bottom: 1.75rem;
        border-bottom: 1px solid var(--settings-border, var(--risu-theme-darkborderc));
        scrollbar-width: none;
        -ms-overflow-style: none;
        scroll-snap-type: x proximity;
    }

    .settings-section-tabs::-webkit-scrollbar {
        display: none;
    }

    button {
        position: relative;
        flex: 0 0 auto;
        min-height: 2.75rem;
        padding: .6rem .85rem;
        color: var(--risu-theme-textcolor2);
        font-size: .79rem;
        font-weight: 560;
        white-space: nowrap;
        scroll-snap-align: start;
        transition: color 140ms ease, background-color 140ms ease;
    }

    button:hover {
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-selected) 24%, transparent);
    }

    button.active {
        color: var(--risu-theme-textcolor);
    }

    button.active::after {
        position: absolute;
        right: .35rem;
        bottom: -1px;
        left: .35rem;
        height: 2px;
        border-radius: 999px 999px 0 0;
        background: var(--risu-theme-primary);
        content: '';
    }

    @media (max-width: 767px) {
        button {
            min-height: 2.7rem;
            padding-inline: .75rem;
            font-size: .78rem;
        }
    }
</style>
