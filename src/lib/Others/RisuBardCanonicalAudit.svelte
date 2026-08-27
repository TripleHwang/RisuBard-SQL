<script lang="ts">
    import { CheckIcon, RotateCcwIcon, ShieldAlertIcon } from '@lucide/svelte'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import {
        reviewCanonicalWikiDocument,
        type NarrativeMemoryWikiMarkdown,
    } from 'src/ts/risubard/memoryWiki'
    import { collectCanonicalAudit } from 'src/ts/risubard/canonicalAudit'

    type WikiDocument = NarrativeMemoryWikiMarkdown['documents'][number]
    interface Props {
        characterId: string
        chatId: string
        documents: WikiDocument[]
        onChanged?: () => void | Promise<void>
        onSelectDocument?: (documentId: string) => void
    }
    let { characterId, chatId, documents, onChanged,
        onSelectDocument }: Props = $props()
    let busyId = $state('')
    let error = $state('')
    let pending = $derived(documents.filter((document) =>
        document.status === 'active'
        && document.type !== 'event'
        && document.reviewStatus === 'unreviewed'
    ))
    let audit = $derived(collectCanonicalAudit(documents))

    async function review(document: WikiDocument, action: 'accept' | 'revert') {
        if (busyId) return
        busyId = document.id
        error = ''
        try {
            await reviewCanonicalWikiDocument({
                characterId,
                chatId,
                documentId: document.id,
                action,
                expectedContentHash: document.contentHash,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            await onChanged?.()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            busyId = ''
        }
    }
</script>

{#if audit.attentionCount > 0}
    <section class="canonical-audit" data-canonical-audit>
        <header>
            <span><ShieldAlertIcon size={16} /> 자동 정본 검수</span>
            <strong data-canonical-audit-count>{audit.attentionCount}건</strong>
        </header>
        <p>AI가 자동 적용한 정본입니다. 현재 내용은 이미 기억 조회에 사용되며 언제든 기준본으로 되돌릴 수 있습니다.</p>
        {#if error}<div class="audit-error" role="alert">{error}</div>{/if}
        {#each audit.unresolvedCandidates as candidate (`${candidate.eventId}:${candidate.type}:${candidate.title}`)}
            <article class="audit-item unresolved">
                <strong>{candidate.conflict ? '충돌' : '자동 처리 보류'} · {candidate.title}</strong>
                <p>{candidate.reason}</p>
                <button type="button" onclick={() => onSelectDocument?.(candidate.eventId)}>
                    근거 사건 열기
                </button>
            </article>
        {/each}
        {#each pending as document (document.id)}
            <details class="audit-item">
                <summary>
                    <span>{document.title}</span>
                    <small>{document.type} · {document.sourceMessageIds.length}개 근거</small>
                </summary>
                <div class="diff-grid">
                    <section>
                        <strong>변경 전</strong>
                        <pre data-canonical-audit-before>{document.reviewBaseContent ?? '(새 정본)'}</pre>
                    </section>
                    <section>
                        <strong>자동 적용 후</strong>
                        <pre data-canonical-audit-after>{document.content}</pre>
                    </section>
                </div>
                <footer>
                    <button
                        type="button"
                        data-canonical-audit-revert
                        disabled={!!busyId}
                        onclick={() => review(document, 'revert')}
                    ><RotateCcwIcon size={14} /> 되돌리기</button>
                    <button
                        type="button"
                        class="accept"
                        data-canonical-audit-accept
                        disabled={!!busyId}
                        onclick={() => review(document, 'accept')}
                    ><CheckIcon size={14} /> 검수 완료</button>
                </footer>
            </details>
        {/each}
    </section>
{/if}

<style>
    .canonical-audit { display:grid; gap:.6rem; padding:.75rem; border:1px solid color-mix(in srgb, var(--risu-theme-primary) 45%, transparent); border-radius:.7rem; background:color-mix(in srgb, var(--risu-theme-primary) 7%, transparent); }
    header, header span, footer, summary { display:flex; align-items:center; gap:.4rem; }
    header, summary { justify-content:space-between; }
    p, small { color:var(--risu-theme-textcolor2); font-size:.75rem; }
    .audit-item { border:1px solid var(--risu-theme-darkborderc); border-radius:.55rem; padding:.55rem; background:var(--risu-theme-bgcolor); }
    .unresolved { display:grid; gap:.35rem; }
    summary { cursor:pointer; }
    .diff-grid { display:grid; grid-template-columns:1fr 1fr; gap:.5rem; margin-top:.6rem; }
    .diff-grid section { min-width:0; }
    pre { max-height:14rem; overflow:auto; white-space:pre-wrap; font-size:.72rem; padding:.5rem; border-radius:.4rem; background:color-mix(in srgb, var(--risu-theme-darkbg) 75%, transparent); }
    footer { justify-content:flex-end; margin-top:.5rem; }
    button { display:inline-flex; align-items:center; gap:.3rem; padding:.35rem .55rem; border-radius:.4rem; }
    .accept { background:var(--risu-theme-primary); color:var(--color-accenttext); }
    .audit-error { color:var(--color-danger); font-size:.75rem; }
    @media (max-width: 720px) { .diff-grid { grid-template-columns:1fr; } }
</style>
