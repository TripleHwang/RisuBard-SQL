<script lang="ts">
  import type { Snippet } from "svelte";


  let {size='md',color, children}: {size?: 'xs'|'sm'|'md'|'lg'|'xl', color?:'primary'|'secondary'|'danger', children?:Snippet} = $props();

</script>

<!--
  We can define button color using template literals,
  but since tailwind doesn't support dynamic class names,
  we need to use a workaround.
--->

{#if color == 'primary'}
  {#if size == 'xs'}
    <button type="button" class={`rounded-xs bg-primary px-2 py-1 text-xs font-semibold text-accenttext shadow-2xs hover:bg-primary/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
      {@render children?.()}
    </button>
    {:else if size == 'sm'}
    <button type="button" class={`rounded-sm bg-primary px-2 py-1 text-sm font-semibold text-accenttext shadow-xs hover:bg-primary/85 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
      {@render children?.()}
    </button>
    {:else if size == 'md'}
    <button type="button" class={`rounded-md bg-primary px-2.5 py-1.5 text-sm font-semibold text-accenttext shadow-xs hover:bg-primary/85 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
      {@render children?.()}
    </button>
    {:else if size == 'lg'}
    <button type="button" class={`rounded-md bg-primary px-3 py-2 text-sm font-semibold text-accenttext shadow-xs hover:bg-primary/85 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
      {@render children?.()}
    </button>
    {:else if size == 'xl'}
    <button type="button" class={`rounded-md bg-primary px-3.5 py-2.5 text-sm font-semibold text-accenttext shadow-xs hover:bg-primary/85 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`}>
      {@render children?.()}
    </button>
  {/if}
{:else if color == 'danger'}
  {#if size == 'xs'}
    <button type="button" class={`rounded-xs bg-danger px-2 py-1 text-xs font-semibold text-on-danger shadow-2xs hover:bg-danger/85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger`}>
      {@render children?.()}
    </button>
    {:else if size == 'sm'}
    <button type="button" class={`rounded-sm bg-danger px-2 py-1 text-sm font-semibold text-on-danger shadow-xs hover:bg-danger/85 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger`}>
      {@render children?.()}
    </button>
    {:else if size == 'md'}
    <button type="button" class={`rounded-md bg-danger px-2.5 py-1.5 text-sm font-semibold text-on-danger shadow-xs hover:bg-danger/85 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger`}>
      {@render children?.()}
    </button>
    {:else if size == 'lg'}
    <button type="button" class={`rounded-md bg-danger px-3 py-2 text-sm font-semibold text-on-danger shadow-xs hover:bg-danger/85 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger`}>
      {@render children?.()}
    </button>
    {:else if size == 'xl'}
    <button type="button" class={`rounded-md bg-danger px-3.5 py-2.5 text-sm font-semibold text-on-danger shadow-xs hover:bg-danger/85 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger`}>
      {@render children?.()}
    </button>
  {/if}
{/if}
