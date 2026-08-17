<script lang="ts">
    import SettingsSectionTabs from './SettingsSectionTabs.svelte'

    interface Tab {
        label: string;
        value: number;
    }

    let {
        tabs,
        selected = $bindable(0),
    }: {
        tabs: Tab[];
        selected?: number;
    } = $props();
</script>

<SettingsSectionTabs
    {tabs}
    {selected}
    onSelect={(value) => { selected = value }}
/>
