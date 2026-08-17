<script lang="ts">
    import { AlertTriangle, BookCheck, RotateCcw } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { CanonicalTurnReceipt } from 'src/ts/risubard/memoryWiki'

    let {
        receipt,
        onUndo,
    }: {
        receipt: CanonicalTurnReceipt
        onUndo: (documentId?: string) => Promise<boolean>
    } = $props()
    let undoing = $state('')
    let error = $state('')

    async function undo(documentId?: string) {
        if (undoing) return
        undoing = documentId ?? '__turn__'
        error = ''
        try {
            await onUndo(documentId)
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            undoing = ''
        }
    }
</script>

<aside class="turn-receipt" data-risubard-turn-receipt>
    <header>
        <span><BookCheck size={15} />{language.risuBardTurnCanon}</span>
        <button
            onclick={() => undo()}
            disabled={Boolean(receipt.undoneAt) || Boolean(undoing)}
            title={language.risuBardUndoTurnCanon}
        >
            <RotateCcw size={14} />{language.risuBardUndoTurnCanon}
        </button>
    </header>
    {#if receipt.changes.length === 0}
        <p>{language.risuBardTurnCanonNoChanges}</p>
    {:else}
        <ul>
            {#each receipt.changes as change (change.documentId)}
                <li
                    class:undone={Boolean(change.undoneAt)}
                    class:conflicted={Boolean(change.undoConflict)}
                >
                    <span>
                        <small>{change.action === 'create'
                            ? language.risuBardCanonCreated
                            : language.risuBardCanonUpdated}</small>
                        {change.title}
                        {#if change.undoConflict}
                            <small class="conflict">
                                {change.undoConflict === 'changed-after-turn'
                                    ? language.risuBardCanonUndoConflictChanged
                                    : language.risuBardCanonUndoConflictMissing}
                            </small>
                        {/if}
                    </span>
                    <button
                        onclick={() => undo(change.documentId)}
                        disabled={Boolean(change.undoneAt) || Boolean(change.undoConflict) || Boolean(receipt.undoneAt) || Boolean(undoing)}
                        title={language.risuBardUndoDocumentCanon}
                    >
                        <RotateCcw size={13} />
                        {change.undoneAt
                            ? language.risuBardCanonUndone
                            : change.undoConflict
                                ? language.risuBardCanonPreserved
                                : language.risuBardUndoDocumentCanon}
                    </button>
                </li>
            {/each}
        </ul>
    {/if}
    {#each receipt.warnings as warning}
        <p class="warning"><AlertTriangle size={13} />{warning}</p>
    {/each}
    {#if error}<p class="error">{error}</p>{/if}
</aside>

<style>
    .turn-receipt { margin: .35rem .5rem .55rem; padding: .55rem .65rem; border: 1px solid color-mix(in srgb, var(--color-darkborderc) 75%, transparent); border-radius: .6rem; background: color-mix(in srgb, var(--risu-theme-bgcolor) 92%, var(--risu-theme-darkbutton)); font-size: .78rem; }
    header, header span, li, li > span, button, .warning { display: flex; align-items: center; gap: .35rem; }
    header, li { justify-content: space-between; }
    header { font-weight: 650; }
    ul { display: grid; gap: .25rem; margin: .45rem 0 0; padding: 0; list-style: none; }
    li small { opacity: .65; min-width: 2.8rem; }
    button { border: 1px solid var(--color-darkborderc); border-radius: .4rem; padding: .2rem .4rem; }
    button:disabled, .undone { opacity: .5; }
    .conflicted { color: #d6a84b; }
    .conflict { min-width: 0; }
    p { margin: .4rem 0 0; opacity: .72; }
    .warning { color: #d6a84b; }
    .error { color: #ef6b73; }
</style>
