<script lang="ts">
    interface Props {
        src: string
        name: string
        size?: number | string
    }

    let { src, name, size = 24 }: Props = $props()
    const cssSize = $derived(typeof size === 'number' ? `${size}px` : size)
</script>

<span
    class="solar-asset-icon"
    data-solar-icon={name}
    aria-hidden="true"
    style={`--solar-asset-url: url("${src}"); --solar-asset-size: ${cssSize}`}
></span>

<style>
    .solar-asset-icon {
        display: block;
        width: var(--solar-asset-size);
        height: var(--solar-asset-size);
        flex: 0 0 var(--solar-asset-size);
        background: currentColor;
        mask: var(--solar-asset-url) center / contain no-repeat;
    }
</style>
