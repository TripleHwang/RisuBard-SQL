<script lang="ts">
    import { collectCbsVariables } from 'src/ts/gui/cbsConditionView'
    let { source }: { source: string } = $props()
    let query = $state('')
    const variables = $derived(collectCbsVariables(source).filter(value => value.name.toLowerCase().includes(query.toLowerCase())))
</script>

<aside class="variables" data-cbs-variable-sidebar aria-label="CBS variables">
    <label>Variables <input aria-label="Search variables" bind:value={query} placeholder="Search" /></label>
    {#each variables as variable (variable.name)}
        <div class="variable"><code>${variable.name}</code><small>{variable.reads} reads · {variable.writes} writes</small>
            {#if variable.values.length}<span>{variable.values.map(value => JSON.stringify(value)).join(' · ')}</span>{/if}</div>
    {:else}<p>No variables found.</p>{/each}
</aside>

<style>
 .variables { height: 100%; overflow: auto; padding: .6rem; border-left: 1px solid var(--color-darkborderc); background: var(--color-bgcolor); font-size: .75rem; }
 label { display:grid; gap:.35rem; font-weight:600; } input { min-width:0; padding:.25rem; border:1px solid var(--color-darkborderc); border-radius:.25rem; color:var(--color-textcolor); background:var(--color-darkbg); } .variable { display:grid; gap:.18rem; padding:.5rem 0; border-bottom:1px solid var(--color-darkborderc); } code { overflow-wrap:anywhere; } small, p, span { color:var(--color-textcolor2); overflow-wrap:anywhere; }
</style>
