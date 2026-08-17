<script lang="ts">
    import { LoaderCircleIcon, ShieldCheckIcon, SparklesIcon, XIcon } from '@lucide/svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import type { NarrativeMemoryWikiMarkdown } from 'src/ts/risubard/memoryWiki'
    import {
        requestIsolatedMarkdownWikiBatchDrafts,
        saveCanonicalWikiDocument,
        type IsolatedMarkdownWikiBatchDraft,
    } from 'src/ts/risubard/markdownWikiWriter'
    import { requestChatData } from 'src/ts/process/request/request'

    type WikiDocument = NarrativeMemoryWikiMarkdown['documents'][number]
    type ReviewDraft = IsolatedMarkdownWikiBatchDraft & {
        state: 'pending' | 'approved' | 'rejected'
    }

    interface Props {
        characterId: string
        chatId: string
        documents: WikiDocument[]
        onApplied?: () => void | Promise<void>
    }

    let { characterId, chatId, documents, onApplied }: Props = $props()
    let selectedIds = $state<string[]>([])
    let evidenceId = $state('')
    let instruction = $state('')
    let drafts = $state<ReviewDraft[]>([])
    let drafting = $state(false)
    let savingId = $state('')
    let error = $state('')

    let canonical = $derived(documents.filter((document) => document.type !== 'event'))
    let evidenceDocuments = $derived(documents.filter((document) =>
        !selectedIds.includes(document.id)
    ))
    let evidence = $derived(
        evidenceDocuments.find((document) => document.id === evidenceId)
            ?? evidenceDocuments.find((document) => document.type === 'event')
            ?? evidenceDocuments[0]
            ?? null
    )

    $effect(() => {
        if (!evidenceId && evidence) evidenceId = evidence.id
    })

    function toggleTarget(id: string) {
        selectedIds = selectedIds.includes(id)
            ? selectedIds.filter((value) => value !== id)
            : selectedIds.length < 8 ? [...selectedIds, id] : selectedIds
        drafts = []
    }

    async function createDrafts() {
        if (drafting || !evidence || selectedIds.length === 0) return
        drafting = true
        error = ''
        drafts = []
        try {
            const results = await requestIsolatedMarkdownWikiBatchDrafts({
                targets: canonical.filter((document) => selectedIds.includes(document.id))
                    .map((document) => ({
                        id: document.id,
                        type: document.type as Exclude<typeof document.type, 'event'>,
                        title: document.title,
                        content: document.content,
                        contentHash: document.contentHash,
                    })),
                instruction,
                evidence: [evidence],
                requestModel: (request, mode) => requestChatData(request, mode),
            })
            drafts = results.map((draft) => ({ ...draft, state: 'pending' }))
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            drafting = false
        }
    }

    function updateDraft(documentId: string, markdown: string) {
        drafts = drafts.map((draft) => draft.documentId === documentId
            ? { ...draft, markdown }
            : draft)
    }

    function reject(documentId: string) {
        drafts = drafts.map((draft) => draft.documentId === documentId
            ? { ...draft, state: 'rejected' }
            : draft)
    }

    async function approve(draft: ReviewDraft) {
        if (draft.state !== 'pending' || savingId) return
        savingId = draft.documentId
        error = ''
        try {
            await saveCanonicalWikiDocument({
                characterId,
                chatId,
                documentId: draft.documentId,
                expectedContentHash: draft.contentHash,
                type: draft.type,
                title: draft.title,
                sourceMessageIds: evidence?.sourceMessageIds ?? [],
                markdown: draft.markdown,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            drafts = drafts.map((item) => item.documentId === draft.documentId
                ? { ...item, state: 'approved' }
                : item)
            await onApplied?.()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            savingId = ''
        }
    }
</script>

<section class="batch-workbench" data-wiki-batch-drafts>
    <header>
        <div><strong>격리된 배치 초안</strong><small>대상마다 새 컨텍스트에서 직렬 생성하고 개별 승인합니다.</small></div>
    </header>
    <div class="batch-controls">
        <fieldset>
            <legend>대상 문서 · 최대 8개</legend>
            {#each canonical as document (document.id)}
                <label>
                    <input
                        type="checkbox"
                        data-wiki-batch-target={document.id}
                        checked={selectedIds.includes(document.id)}
                        onchange={() => toggleTarget(document.id)}
                    />
                    <span>{document.type} · {document.title}</span>
                </label>
            {/each}
        </fieldset>
        <label><span>공통 근거</span><select bind:value={evidenceId}>
            {#each evidenceDocuments as document (document.id)}
                <option value={document.id}>{document.type} · {document.title}</option>
            {/each}
        </select></label>
        <label><span>작업 지시</span><textarea data-wiki-batch-instruction bind:value={instruction} rows="3" maxlength="4000"></textarea></label>
        <ShButton data-wiki-batch-create size="sm" variant="secondary" onclick={createDrafts} disabled={drafting || selectedIds.length === 0 || !instruction.trim() || !evidence}>
            {#if drafting}<LoaderCircleIcon class="animate-spin" size={14} />{:else}<SparklesIcon size={14} />{/if}
            배치 초안 만들기
        </ShButton>
    </div>
    {#if drafts.length > 0}
        <div class="draft-list">
            {#each drafts as draft (draft.documentId)}
                <article data-wiki-batch-review={draft.documentId} class:resolved={draft.state !== 'pending'}>
                    <header><strong>{draft.title}</strong><span>{draft.state}</span></header>
                    <textarea value={draft.markdown} rows="8" maxlength="12000" disabled={draft.state !== 'pending'} oninput={(event) => updateDraft(draft.documentId, event.currentTarget.value)}></textarea>
                    <footer>
                        <ShButton size="sm" variant="ghost" onclick={() => reject(draft.documentId)} disabled={draft.state !== 'pending' || !!savingId}><XIcon size={14} />거부</ShButton>
                        <ShButton data-wiki-batch-approve={draft.documentId} size="sm" variant="success" onclick={() => approve(draft)} disabled={draft.state !== 'pending' || !!savingId}>
                            {#if savingId === draft.documentId}<LoaderCircleIcon class="animate-spin" size={14} />{:else}<ShieldCheckIcon size={14} />{/if}승인
                        </ShButton>
                    </footer>
                </article>
            {/each}
        </div>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
    .batch-workbench { margin-top: 1rem; padding: .8rem; border: 1px solid var(--risu-theme-darkborderc); border-radius: .65rem; background: color-mix(in srgb, var(--risu-theme-darkbg) 96%, black); }
    header { display: flex; justify-content: space-between; gap: .6rem; }
    header div { display: grid; gap: .18rem; }
    header small, legend, label > span { color: var(--risu-theme-textcolor2); font-size: .7rem; }
    .batch-controls { display: grid; gap: .65rem; margin-top: .75rem; }
    fieldset { display: flex; flex-wrap: wrap; gap: .4rem .8rem; margin: 0; border: 1px solid var(--risu-theme-darkborderc); border-radius: .4rem; }
    fieldset label { display: flex; align-items: center; gap: .3rem; }
    .batch-controls > label { display: grid; gap: .25rem; }
    select, textarea { box-sizing: border-box; width: 100%; padding: .45rem; border: 1px solid var(--risu-theme-darkborderc); border-radius: .35rem; color: var(--risu-theme-textcolor); background: var(--risu-theme-darkbg); }
    .draft-list { display: grid; gap: .7rem; margin-top: .8rem; }
    article { padding: .6rem; border: 1px solid var(--risu-theme-darkborderc); border-radius: .45rem; }
    article.resolved { opacity: .7; }
    article footer { display: flex; justify-content: flex-end; gap: .4rem; margin-top: .4rem; }
    .error { color: #ef6b73; }
</style>
