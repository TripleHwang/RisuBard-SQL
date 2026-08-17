<script lang="ts">
    interface Props {
        src: string
        name: string
        size?: string
    }

    let { src, name, size = '1em' }: Props = $props()
</script>

<!-- Solar Icons (Bold), 480 Design, CC BY 4.0. -->
<span
    class="solar-icon"
    data-solar-icon={name}
    aria-hidden="true"
    style={`--solar-icon-url: url("${src}"); --solar-icon-size: ${size}`}
></span>

<style>
    .solar-icon {
        display: inline-block;
        width: var(--solar-icon-size);
        height: var(--solar-icon-size);
        flex: 0 0 var(--solar-icon-size);
        background: currentColor;
        mask: var(--solar-icon-url) center / contain no-repeat;
    }
</style>
