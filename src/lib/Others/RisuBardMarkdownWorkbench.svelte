<script lang="ts">
    import {
        FeatherIcon,
        LoaderCircleIcon,
        ShieldCheckIcon,
        SparklesIcon,
        XIcon,
    } from '@lucide/svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { language } from 'src/lang'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import type { NarrativeMemoryWikiMarkdown } from 'src/ts/risubard/memoryWiki'
    import {
        requestMarkdownWikiDraft,
        saveCanonicalWikiDocument,
        type CanonicalWikiDocumentType,
    } from 'src/ts/risubard/markdownWikiWriter'
    import { requestChatData } from 'src/ts/process/request/request'
    import { publishRisuBardMemoryActivity } from 'src/ts/risubard/memoryActivity'

    type WikiDocument = NarrativeMemoryWikiMarkdown['documents'][number]

    interface Props {
        characterId: string
        chatId: string
        documents: WikiDocument[]
        targetId?: string
        onApplied?: () => void | Promise<void>
    }

    let {
        characterId,
        chatId,
        documents,
        targetId = $bindable('__new__'),
        onApplied,
    }: Props = $props()
    let evidenceId = $state('')
    let targetType = $state<CanonicalWikiDocumentType>('character')
    let title = $state('')
    let instruction = $state('')
    let draft = $state('')
    let drafting = $state(false)
    let saving = $state(false)
    let error = $state('')
    let notice = $state('')
    let draftTargetHash = $state('')

    let canonicalDocuments = $derived(documents.filter((document) =>
        document.type !== 'event'
    ))
    let evidenceDocuments = $derived(documents.filter((document) =>
        document.id !== targetId
    ))
    let targetDocument = $derived(
        canonicalDocuments.find((document) => document.id === targetId) ?? null
    )
    let evidenceDocument = $derived(
        evidenceDocuments.find((document) => document.id === evidenceId)
            ?? evidenceDocuments.find((document) => document.type === 'event')
            ?? evidenceDocuments[0]
            ?? null
    )

    $effect(() => {
        if (!evidenceId && evidenceDocument) evidenceId = evidenceDocument.id
    })
    $effect(() => {
        const target = targetDocument
        if (!target) return
        targetType = target.type as CanonicalWikiDocumentType
        title = target.title
    })

    function resetDraft() {
        draft = ''
        draftTargetHash = ''
        notice = ''
    }

    function clearTarget() {
        targetId = '__new__'
        targetType = 'character'
        title = ''
        resetDraft()
    }

    async function createDraft() {
        if (!evidenceDocument || drafting) return
        drafting = true
        error = ''
        notice = ''
        const startedAt = performance.now()
        publishRisuBardMemoryActivity({
            characterId,
            chatId,
            operation: 'request',
            timestamp: Date.now(),
            message: 'AI 위키 초안 요청 시작',
            wikiPaths: [
                ...(targetDocument ? [targetDocument.relativePath] : []),
                evidenceDocument.relativePath,
            ],
        })
        try {
            draft = await requestMarkdownWikiDraft({
                type: targetType,
                title,
                currentContent: targetDocument?.content,
                instruction,
                evidence: [evidenceDocument],
                requestModel: (request, mode) => requestChatData(request, mode),
            })
            draftTargetHash = targetDocument?.contentHash ?? ''
            publishRisuBardMemoryActivity({
                characterId,
                chatId,
                operation: 'request',
                timestamp: Date.now(),
                message: `AI 위키 초안 수신 · ${Math.round(performance.now() - startedAt)} ms`,
                wikiPaths: [evidenceDocument.relativePath],
            })
        }
        catch (cause) {
            error = `${language.risuBardMarkdownWriterDraftFailed} ${
                cause instanceof Error ? cause.message : String(cause)
            }`
        }
        finally {
            drafting = false
        }
    }

    async function approve() {
        if (!draft || !evidenceDocument || saving) return
        saving = true
        error = ''
        notice = ''
        try {
            await saveCanonicalWikiDocument({
                characterId,
                chatId,
                ...(targetDocument ? { documentId: targetDocument.id } : {}),
                ...(targetDocument ? {
                    expectedContentHash: draftTargetHash,
                } : {}),
                type: targetType,
                title,
                sourceMessageIds: evidenceDocument.sourceMessageIds,
                markdown: draft,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            notice = language.risuBardMarkdownWriterSaved
            publishRisuBardMemoryActivity({
                characterId,
                chatId,
                operation: 'wiki-save',
                timestamp: Date.now(),
                message: `${targetDocument?.relativePath ?? title} AI 승인 저장`,
                wikiPaths: targetDocument ? [targetDocument.relativePath] : [],
            })
            await onApplied?.()
        }
        catch (cause) {
            error = `${language.risuBardMarkdownWriterSaveFailed} ${
                cause instanceof Error ? cause.message : String(cause)
            }`
        }
        finally {
            saving = false
        }
    }
</script>

<section class="wiki-workbench" data-markdown-writer>
    <header>
        <span class="seal"><FeatherIcon size={16} /></span>
        <div>
            <strong>{language.risuBardMarkdownWriterTitle}</strong>
            <small>{language.risuBardMarkdownWriterDescription}</small>
        </div>
    </header>
    <div class="workbench-grid">
        <div class="controls">
            <label>
                <span>{language.risuBardMarkdownWriterTarget}</span>
                <div class="target-token" data-markdown-writer-target>
                    {#if targetDocument}
                        <span>{targetDocument.type} · <strong>{targetDocument.title}</strong></span>
                        <button
                            type="button"
                            data-markdown-writer-clear-target
                            aria-label="작업대 대상 해제"
                            title="새 문서로 초기화"
                            onclick={clearTarget}
                        ><XIcon size={14} /></button>
                    {:else}
                        <span>＋ <strong>{language.risuBardMarkdownWriterNew}</strong></span>
                    {/if}
                </div>
            </label>
            {#if !targetDocument}
                <div class="target-new">
                    <label>
                        <span>{language.risuBardMarkdownWriterType}</span>
                        <select bind:value={targetType} onchange={resetDraft}>
                            <option value="character">character</option>
                            <option value="location">location</option>
                            <option value="scene">current scene</option>
                        </select>
                    </label>
                    <label>
                        <span>{language.risuBardMarkdownWriterName}</span>
                        <input data-markdown-writer-new-title bind:value={title} maxlength="160" oninput={resetDraft} />
                    </label>
                </div>
            {/if}
            <label>
                <span>{language.risuBardMarkdownWriterEvidence}</span>
                <select bind:value={evidenceId} onchange={resetDraft}>
                    {#each evidenceDocuments as document (document.id)}
                        <option value={document.id}>{document.type} · {document.title}</option>
                    {/each}
                </select>
            </label>
            <label>
                <span>{language.risuBardWriterInstruction}</span>
                <textarea
                    data-markdown-writer-instruction
                    bind:value={instruction}
                    rows="3"
                    maxlength="4000"
                    placeholder={language.risuBardMarkdownWriterPlaceholder}
                    oninput={resetDraft}
                ></textarea>
            </label>
            <ShButton
                variant="secondary"
                size="sm"
                data-markdown-writer-draft
                onclick={createDraft}
                disabled={drafting || !title.trim() || !instruction.trim() || !evidenceDocument}
            >
                {#if drafting}<LoaderCircleIcon class="animate-spin" size={14} />
                {:else}<SparklesIcon size={14} />{/if}
                {language.risuBardWriterDraft}
            </ShButton>
        </div>
        <label class="draft-page">
            <span>{language.risuBardMarkdownWriterDraft}</span>
            <textarea bind:value={draft} rows="12" maxlength="12000"></textarea>
        </label>
    </div>
    <footer>
        <div aria-live="polite">
            {#if error}<span class="error" role="alert">{error}</span>
            {:else if notice}<span class="success">{notice}</span>
            {:else}<span>{language.risuBardMarkdownWriterApprovalHint}</span>{/if}
        </div>
        <ShButton
            variant="success"
            size="sm"
            data-markdown-writer-apply
            onclick={approve}
            disabled={!draft.trim() || saving}
        >
            {#if saving}<LoaderCircleIcon class="animate-spin" size={14} />
            {:else}<ShieldCheckIcon size={14} />{/if}
            {language.risuBardWriterApply}
        </ShButton>
    </footer>
</section>

<style>
    .wiki-workbench {
        --line: color-mix(in srgb, var(--risu-theme-primary) 28%, transparent);
        margin-top: 1rem;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: .65rem;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 96%, black);
    }
    header, footer {
        display: flex;
        align-items: center;
        gap: .65rem;
        padding: .65rem .75rem;
        background: color-mix(in srgb, var(--risu-theme-primary) 7%, transparent);
    }
    header { border-bottom: 1px solid var(--line); }
    footer { justify-content: space-between; border-top: 1px solid var(--line); }
    header div { display: grid; gap: .08rem; }
    header strong { font: 650 .85rem/1.2 Georgia, serif; }
    header small, footer div { color: var(--risu-theme-textcolor2); font-size: .68rem; }
    .seal {
        display: grid;
        place-items: center;
        width: 1.8rem;
        height: 1.8rem;
        border: 1px solid var(--line);
        border-radius: 50%;
        color: var(--risu-theme-primary);
    }
    .workbench-grid { display: grid; grid-template-columns: minmax(14rem, .85fr) minmax(0, 1.15fr); }
    .controls, .draft-page { display: grid; align-content: start; gap: .55rem; padding: .75rem; }
    .controls { border-right: 1px solid var(--line); }
    .target-new { display: grid; grid-template-columns: .7fr 1.3fr; gap: .5rem; }
    .target-token {
        display: flex;
        min-height: 2.05rem;
        align-items: center;
        justify-content: space-between;
        gap: .5rem;
        box-sizing: border-box;
        padding: .35rem .45rem .35rem .6rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .38rem;
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-primary) 8%, var(--risu-theme-darkbg));
    }
    .target-token button {
        display: grid;
        place-items: center;
        width: 1.45rem;
        height: 1.45rem;
        padding: 0;
        border: 0;
        border-radius: .25rem;
        color: var(--risu-theme-textcolor2);
        background: transparent;
        cursor: pointer;
    }
    .target-token button:hover { color: var(--risu-theme-textcolor); background: color-mix(in srgb, var(--risu-theme-primary) 16%, transparent); }
    label { display: grid; gap: .25rem; color: var(--risu-theme-textcolor2); font-size: .68rem; font-weight: 600; }
    input, select, textarea {
        width: 100%;
        box-sizing: border-box;
        padding: .46rem .52rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .38rem;
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 88%, black);
        font: inherit;
    }
    textarea { resize: vertical; line-height: 1.55; }
    .draft-page textarea { min-height: 13rem; font-family: ui-monospace, monospace; font-size: .72rem; }
    input:focus-visible, select:focus-visible, textarea:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--risu-theme-primary) 55%, transparent);
        outline-offset: 1px;
    }
    .error { color: var(--risu-theme-draculared); }
    .success { color: var(--risu-theme-success); }
    @media (max-width: 760px) {
        .workbench-grid { grid-template-columns: 1fr; }
        .controls { border-right: 0; border-bottom: 1px solid var(--line); }
    }
</style>
