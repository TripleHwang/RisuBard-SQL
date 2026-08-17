<script lang="ts">
    import type { Snippet } from "svelte";

    let {
        title,
        description,
        showTitle = true,
        children,
    }: {
        title: string;
        description?: string;
        showTitle?: boolean;
        children?: Snippet;
    } = $props();
</script>

<section data-settings-page class="settings-standard-page">
    {#if showTitle}
        <header data-settings-page-header class="settings-standard-page__header">
            <h1>{title}</h1>
            {#if description}
                <p>{description}</p>
            {/if}
        </header>
    {/if}
    <div data-settings-page-body class="settings-standard-page__body">
        {@render children?.()}
    </div>
</section>
