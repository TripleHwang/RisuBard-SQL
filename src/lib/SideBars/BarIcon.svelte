<!-- TODO: REMOVE AND REFACTOR TO BASE BUTTON UI COMPONENT -->

<script lang="ts">
  interface Props {
    onClick?: any;
    additionalStyle?: string | Promise<string>;
    children?: import('svelte').Snippet;
  }

  let { onClick = () => {}, additionalStyle = "", children }: Props = $props();
</script>

{#await additionalStyle}
  <button onclick={onClick} class="ico">{@render children?.()}</button>
{:then as}
  <button onclick={onClick} class="ico" style={as}>{@render children?.()}</button>
{/await}

<style>
  .ico {
    cursor: pointer;
    border-radius: 0.375rem;
    height: 3.5rem;
    width: 3.5rem;
    min-height: 3.5rem;
    --tw-shadow-color: var(--color-shadow);
    --tw-shadow: 0 10px 15px -3px color-mix(in srgb, var(--tw-shadow-color) 10%, transparent),
      0 4px 6px -2px color-mix(in srgb, var(--tw-shadow-color) 5%, transparent);
    -webkit-box-shadow: var(--tw-ring-offset-shadow, 0 0 transparent),
      var(--tw-ring-shadow, 0 0 transparent), var(--tw-shadow);
    box-shadow: var(--tw-ring-offset-shadow, 0 0 transparent),
      var(--tw-ring-shadow, 0 0 transparent), var(--tw-shadow);
    --tw-bg-opacity: 1;
    background-color: color-mix(in srgb, var(--color-selected) calc(var(--tw-bg-opacity) * 100%), transparent);
    display: flex;
    justify-content: center;
    align-items: center;
    transition-property: background-color, border-color, color, fill, stroke;
    transition-duration: 150ms;
    transition-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
  }

  .ico:hover {
    background-color: var(--risu-theme-primary);
  }
</style>
