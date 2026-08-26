<script lang="ts">
    import { parseCbsConditionView } from 'src/ts/gui/cbsConditionView'
    import CbsVariableList from './CbsVariableList.svelte'
    let { value, onInput, onblur, onkeydown }: { value: string; onInput: (value: string) => void; onblur?: () => void; onkeydown?: (event: KeyboardEvent) => void } = $props()
    let showVariables = $state(true)
    const parsed = $derived(parseCbsConditionView(value))
</script>

<div class="cbs" data-cbs-condition-view class:invalid={!parsed.valid}>
 <div class="toolbar"><span>{parsed.valid ? 'CBS branch view' : 'Unbalanced CBS source — showing raw text'}</span><button type="button" aria-pressed={showVariables} onclick={() => showVariables = !showVariables}>Variables</button></div>
 <div class="body"><div class="document">{#each parsed.parts as part}<section class:branch={part.kind === 'condition'} class:otherwise={part.kind === 'otherwise'} style:margin-left={`${part.depth * .65}rem`}>
  {#if part.kind === 'condition'}<code>{value.slice(part.from, part.to)}</code>
  {:else if part.kind === 'otherwise'}<strong>Otherwise</strong>
  {:else if part.kind === 'end'}<hr />
  {:else}<textarea aria-label="CBS branch text" value={value.slice(part.from, part.to)} oninput={(event) => onInput(value.slice(0, part.from) + event.currentTarget.value + value.slice(part.to))} {onblur} {onkeydown}></textarea>{/if}
 </section>{/each}</div>{#if showVariables}<CbsVariableList source={value} />{/if}</div>
</div>

<style>
.cbs{display:flex;flex-direction:column;min-height:0;height:100%;border:1px solid var(--color-darkborderc);background:var(--color-darkbg)}.toolbar{display:flex;justify-content:space-between;gap:.5rem;padding:.35rem .5rem;border-bottom:1px solid var(--color-darkborderc);font-size:.75rem;color:var(--color-textcolor2)}button{padding:.2rem .45rem;border:1px solid var(--color-darkborderc);border-radius:.25rem;color:var(--color-textcolor);background:transparent}.body{display:grid;grid-template-columns:minmax(0,1fr) minmax(9rem,16rem);min-height:0;flex:1}.document{overflow:auto;padding:.45rem}section{min-width:0}.branch{margin:.25rem 0;padding:.35rem;border-left:2px solid var(--color-borderc);background:color-mix(in srgb,var(--color-selected) 18%,transparent)}.otherwise{padding:.25rem;color:var(--color-textcolor2);font-size:.75rem}textarea{display:block;width:100%;min-height:3rem;resize:vertical;border:1px solid transparent;background:transparent;color:var(--color-textcolor);font:inherit;line-height:1.6}textarea:focus{border-color:var(--color-borderc);outline:none;background:var(--color-bgcolor)}code{overflow-wrap:anywhere}@container(max-width:500px){.body{grid-template-columns:1fr}.body :global(.variables){border-left:0;border-top:1px solid var(--color-darkborderc);max-height:14rem}}
</style>
