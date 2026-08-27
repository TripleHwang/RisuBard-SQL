<script lang="ts">
  interface Props {
    isDisabled?: boolean;
    onClick: () => void;
    children?: import('svelte').Snippet;
  }

  let { isDisabled = false, onClick, children }: Props = $props();
</script>

<button
  disabled={isDisabled}
  onclick={onClick}
  class="flex h-[56px] w-[56px] cursor-pointer select-none items-center justify-center
   transition-colors rounded-full
   border border-textcolor2 text-textcolor
   hover:border-borderc
   {isDisabled ? 'cursor-not-allowed!' : ''}"
>
  {@render children?.()}
</button>
