<script lang="ts">
    import {
        FileIcon,
        FileLock2Icon,
        BookCopyIcon,
        FolderIcon,
        FolderOpenIcon,
        RotateCcwIcon,
        SaveIcon,
        Trash2Icon,
        PlusIcon,
    } from '@lucide/svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { v4 } from 'uuid'
    import { forageStorage, requestImmediateSave } from 'src/ts/globalApi.svelte'
    import { DBState } from 'src/ts/stores.svelte'
    import { alertConfirmMulti } from 'src/ts/alert'
    import {
        saveManualWikiDocument,
        setWikiDocumentContextMode,
        revealWikiDocument,
        retractWikiEvent,
        trashWikiDocument,
        type CanonicalMarkdownWikiDocumentType,
        type NarrativeMemoryWikiMarkdown,
    } from 'src/ts/risubard/memoryWiki'
    import { buildWikiFileTree } from 'src/ts/risubard/wikiFileTree'
    import { publishRisuBardMemoryActivity } from 'src/ts/risubard/memoryActivity'
    import { copyWikiDocumentToLorebook } from 'src/ts/risubard/wikiLorebookCopy'

    type WikiDocument = NarrativeMemoryWikiMarkdown['documents'][number]

    interface Props {
        characterId: string
        chatId: string
        documents: WikiDocument[]
        health?: NarrativeMemoryWikiMarkdown['health']
        selectedId?: string
        onChanged?: () => void | Promise<void>
        onSelected?: (documentId: string) => void
    }

    let {
        characterId,
        chatId,
        documents,
        health = { danglingLinks: [], unlinkedDocumentIds: [] },
        selectedId = $bindable(''),
        onChanged,
        onSelected,
    }: Props = $props()
    let creating = $state(false)
    let type = $state<CanonicalMarkdownWikiDocumentType>('character')
    let title = $state('')
    let markdown = $state('')
    let saving = $state(false)
    let error = $state('')
    let notice = $state('')
    let loadedDocumentId = $state('')
    let loadedContentHash = $state('')
    let loadedType = $state<CanonicalMarkdownWikiDocumentType>('character')
    let loadedTitle = $state('')
    let loadedMarkdown = $state('')
    let contextDocumentId = $state('')
    let contextX = $state(0)
    let contextY = $state(0)

    let tree = $derived(buildWikiFileTree(documents))
    let selected = $derived(
        documents.find((document) => document.id === selectedId) ?? null
    )
    let readOnly = $derived(selected?.type === 'event' && !creating)
    let contextDocument = $derived(
        documents.find((document) => document.id === contextDocumentId) ?? null
    )
    let dirty = $derived(creating
        ? title.trim().length > 0 || markdown.trim().length > 0
        : !!selected && (title !== loadedTitle
            || type !== loadedType
            || markdown !== loadedMarkdown))

    function loadDocument(document: WikiDocument) {
        selectedId = document.id
        creating = false
        type = document.type === 'event' ? 'other' : document.type
        title = document.title
        markdown = document.content
        loadedDocumentId = document.id
        loadedContentHash = document.contentHash
        loadedType = document.type === 'event' ? 'other' : document.type
        loadedTitle = document.title
        loadedMarkdown = document.content
        error = ''
        notice = ''
        onSelected?.(document.id)
    }

    function startNew() {
        selectedId = ''
        creating = true
        type = 'character'
        title = ''
        markdown = ''
        error = ''
        notice = ''
    }

    function openContextMenu(event: MouseEvent, documentId: string) {
        event.preventDefault()
        contextDocumentId = documentId
        contextX = Math.min(event.clientX, Math.max(8, window.innerWidth - 190))
        contextY = Math.min(event.clientY, Math.max(8, window.innerHeight - 96))
    }

    function closeContextMenu() {
        contextDocumentId = ''
    }

    function closeContextMenuFromWindow(event: MouseEvent) {
        if (!(event.target as Element | null)?.closest?.('.file-context-menu')) {
            closeContextMenu()
        }
    }

    async function revealFile() {
        if (!contextDocument) return
        const documentId = contextDocument.id
        closeContextMenu()
        error = ''
        try {
            await revealWikiDocument({
                characterId,
                chatId,
                documentId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
    }

    async function changeContextMode(mode: 'always' | 'auto' | 'never') {
        if (!contextDocument
            || contextDocument.type === 'event'
            || contextDocument.type === 'scene') return
        const target = contextDocument
        closeContextMenu()
        saving = true
        error = ''
        try {
            await setWikiDocumentContextMode({
                characterId,
                chatId,
                documentId: target.id,
                contextMode: mode,
                expectedContentHash: target.contentHash,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            publishRisuBardMemoryActivity({
                characterId,
                chatId,
                operation: 'wiki-save',
                timestamp: Date.now(),
                message: `${target.relativePath} context ${mode}`,
                wikiPaths: [target.relativePath],
            })
            await onChanged?.()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            saving = false
        }
    }

    function revert() {
        if (creating) {
            startNew()
            return
        }
        if (selected) loadDocument(selected)
    }

    async function save() {
        if (saving || readOnly || !title.trim() || !markdown.trim()) return
        saving = true
        error = ''
        notice = ''
        try {
            const saved = await saveManualWikiDocument({
                characterId,
                chatId,
                ...(selected && !creating ? { documentId: selected.id } : {}),
                ...(selected && !creating ? {
                    expectedContentHash: loadedContentHash,
                } : {}),
                type,
                title,
                markdown,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            selectedId = saved.id
            creating = false
            notice = '저장했습니다.'
            publishRisuBardMemoryActivity({
                characterId,
                chatId,
                operation: 'wiki-save',
                timestamp: Date.now(),
                message: `${saved.relativePath} 저장`,
                wikiPaths: [saved.relativePath],
            })
            await onChanged?.()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            saving = false
        }
    }

    async function trash() {
        if (!selected || creating || readOnly || saving) return
        const backlinks = documents.filter((document) =>
            document.id !== selected.id
            && document.links.includes(selected.title)
        ).length
        if (!confirm(`“${selected.title}” 문서를 휴지통으로 이동할까요? 연결된 문서 ${backlinks}개가 남습니다.`)) return
        saving = true
        error = ''
        try {
            await trashWikiDocument({
                characterId,
                chatId,
                documentId: selected.id,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            publishRisuBardMemoryActivity({
                characterId,
                chatId,
                operation: 'wiki-trash',
                timestamp: Date.now(),
                message: `${selected.relativePath} 휴지통 이동`,
                wikiPaths: [selected.relativePath],
            })
            selectedId = ''
            await onChanged?.()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            saving = false
        }
    }

    async function retractEvent() {
        if (!selected
            || selected.type !== 'event'
            || selected.status !== 'active'
            || saving) return
        if (!confirm(
            `“${selected.title}” 사건을 영구 삭제할까요? 삭제한 사건은 복구할 수 없습니다.`
        )) return
        const target = selected
        saving = true
        error = ''
        notice = ''
        try {
            await retractWikiEvent({
                characterId,
                chatId,
                documentId: target.id,
                expectedContentHash: target.contentHash,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            notice = '사건을 영구 삭제했습니다.'
            publishRisuBardMemoryActivity({
                characterId,
                chatId,
                operation: 'wiki-retract',
                timestamp: Date.now(),
                message: `${target.relativePath} 사건 영구 삭제`,
                wikiPaths: [target.relativePath],
            })
            await onChanged?.()
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            saving = false
        }
    }

    async function copySelectedToLorebook() {
        if (!selected || dirty || saving) return
        const target = selected
        const character = DBState.db.characters.find((item) =>
            item.chaId === characterId
        )
        if (!character) {
            error = '이 BardWiki에 연결된 캐릭터를 찾을 수 없습니다.'
            return
        }
        let policy: 'overwrite' | 'suffix' = 'suffix'
        const hasSameName = character.globalLore.some((entry) =>
            entry.mode !== 'folder'
            && entry.comment.trim() === target.title.trim()
        )
        if (hasSameName) {
            const choice = await alertConfirmMulti(
                '같은 이름의 로어북 항목이 있습니다.',
                [
                    { label: '덮어쓰기', variant: 'primary' },
                    { label: '새 항목으로 복사', variant: 'secondary' },
                ],
                '덮어쓰기는 기존 항목을 비활성화하고 키워드를 비웁니다. 새 항목은 이름 뒤에 숫자를 붙입니다.'
            )
            if (choice < 0) return
            policy = choice === 0 ? 'overwrite' : 'suffix'
        }
        const previousLorebooks = character.globalLore
        const result = copyWikiDocumentToLorebook(
            character.globalLore,
            { title: target.title, content: target.content },
            policy,
            v4
        )
        saving = true
        error = ''
        notice = ''
        character.globalLore = result.lorebooks
        try {
            await requestImmediateSave({
                forceFullWrite: true,
                rejectOnFailure: true,
            })
            notice = `로어북 “${result.entry.comment}” ${
                result.action === 'overwritten' ? '덮어쓰기' : '복사'
            } 완료 · 비활성 상태`
        }
        catch (cause) {
            character.globalLore = previousLorebooks
            error = `로어북 복사 실패: ${cause instanceof Error
                ? cause.message
                : String(cause)}`
        }
        finally {
            saving = false
        }
    }

    $effect(() => {
        const current = documents.find((document) => document.id === selectedId)
            ?? documents[0]
        if (creating || !current) return
        const incomingType = current.type === 'event' ? 'other' : current.type
        const matchesIncoming = title === current.title
            && type === incomingType
            && markdown === current.content
        if (current.id !== selectedId
            || current.id !== loadedDocumentId
            || (current.contentHash !== loadedContentHash
                && (!dirty || matchesIncoming))) loadDocument(current)
    })
</script>

<svelte:window onclick={closeContextMenuFromWindow} />

<section class="wiki-editor" data-wiki-editor>
    <nav class="file-tree" aria-label="위키 파일 트리">
        <div class="tree-toolbar">
            <strong>WIKI</strong>
            <ShButton size="sm" variant="ghost" onclick={startNew} aria-label="새 문서">
                <PlusIcon size={14} /> 새 문서
            </ShButton>
        </div>
        <div class="wiki-health" aria-label="위키 건강도">
            <span>끊어진 링크 {health.danglingLinks.length}</span>
            <span>연결 없음 {health.unlinkedDocumentIds.length}</span>
        </div>
        {#each tree as node (node.path)}
            {#if node.kind === 'folder'}
                <details open class="tree-folder">
                    <summary class:locked={node.readOnly} class="folder-row">
                        <FolderIcon size={14} />
                        <span>{node.name}</span>
                        {#if node.readOnly}<FileLock2Icon size={12} />{/if}
                    </summary>
                    <div class="folder-children">
                        {#each node.children as child (child.path)}
                            {#if child.kind === 'file'}
                                <button
                                    type="button"
                                    class:active={selectedId === child.documentId}
                                    onclick={() => {
                                        const document = documents.find((item) => item.id === child.documentId)
                                        if (document) loadDocument(document)
                                    }}
                                    oncontextmenu={(event) => openContextMenu(event, child.documentId)}
                                    aria-label={`${child.title} ${child.readOnly ? '읽기 전용' : ''}`}
                                >
                                    {#if child.readOnly}<FileLock2Icon size={13} />
                                    {:else}<FileIcon size={13} />{/if}
                                    <span>{child.title}</span>
                                </button>
                            {/if}
                        {/each}
                    </div>
                </details>
            {:else}
                <button
                    type="button"
                    class="root-file"
                    class:active={selectedId === node.documentId}
                    onclick={() => {
                        const document = documents.find((item) => item.id === node.documentId)
                        if (document) loadDocument(document)
                    }}
                    oncontextmenu={(event) => openContextMenu(event, node.documentId)}
                    aria-label={node.title}
                >
                    <FileIcon size={13} /><span>{node.title}</span>
                </button>
            {/if}
        {/each}
    </nav>

    <div class="editor-pane">
        <header class="editor-toolbar">
            <label>
                <span>항목 유형</span>
                <select aria-label="항목 유형" bind:value={type} disabled={readOnly}>
                    <option value="character">캐릭터</option>
                    <option value="location">장소</option>
                    <option value="faction">세력</option>
                    <option value="item">사물</option>
                    <option value="concept">개념</option>
                    <option value="scene">현재 장면</option>
                    <option value="other">기타</option>
                </select>
            </label>
            <label class="title-field">
                <span>항목 이름</span>
                <input aria-label="항목 이름" bind:value={title} maxlength="160" readonly={readOnly} />
            </label>
            <div class="editor-actions">
                <ShButton
                    size="sm"
                    variant="ghost"
                    onclick={() => void copySelectedToLorebook()}
                    disabled={!selected || dirty || saving}
                >
                    <BookCopyIcon size={14} /> 로어북에 복사
                </ShButton>
                <ShButton size="sm" variant="ghost" onclick={revert} disabled={!dirty || saving}>
                    <RotateCcwIcon size={14} /> 되돌리기
                </ShButton>
                <ShButton size="sm" variant="ghost" onclick={trash} disabled={!selected || creating || readOnly || saving}>
                    <Trash2Icon size={14} /> 삭제
                </ShButton>
                {#if selected?.type === 'event' && selected.status === 'active'}
                    <ShButton size="sm" variant="ghost" onclick={retractEvent} disabled={saving}>
                        <Trash2Icon size={14} /> 사건 영구 삭제
                    </ShButton>
                {/if}
                <ShButton size="sm" variant="success" onclick={save} disabled={readOnly || saving || !dirty || !title.trim() || !markdown.trim()}>
                    <SaveIcon size={14} /> 저장
                </ShButton>
            </div>
        </header>
        <div class="document-meta">
            <code>{creating ? '새 문서' : selected?.relativePath ?? '문서를 선택하세요'}</code>
            {#if selected?.status === 'retracted'}<span class="readonly-badge">철회된 사건 기록</span>
            {:else if readOnly}<span class="readonly-badge">읽기 전용 사건 기록</span>
            {:else if dirty}<span class="dirty-badge">저장하지 않은 변경</span>{/if}
            {#if selected}<span class="context-badge">context: {selected.contextMode}</span>{/if}
        </div>
        <textarea
            class="markdown-editor"
            aria-label="Markdown"
            bind:value={markdown}
            readonly={readOnly}
            maxlength="12000"
            spellcheck="false"
        ></textarea>
        <div class="editor-status" aria-live="polite">
            {#if error}<span class="error">{error}</span>
            {:else if notice}<span class="success">{notice}</span>
            {:else if selected?.status === 'retracted'}<span>철회되어 활성 컨텍스트와 자동 처리에서 제외된 감사 기록입니다.</span>
            {:else if readOnly}<span>이 파일은 확정된 채팅과 연결된 근거이므로 여기서 수정할 수 없습니다.</span>{/if}
        </div>
    </div>
</section>

{#if contextDocument}
    <div
        class="file-context-menu"
        role="menu"
        tabindex="-1"
        aria-label={`${contextDocument.title} 파일 메뉴`}
        style:left={`${contextX}px`}
        style:top={`${contextY}px`}
    >
        {#if contextDocument.type !== 'event' && contextDocument.type !== 'scene'}
            <button type="button" role="menuitem" data-wiki-context-always onclick={() => changeContextMode('always')}>
                항상 컨텍스트에 포함
            </button>
            <button type="button" role="menuitem" data-wiki-context-auto onclick={() => changeContextMode('auto')}>
                관련 있을 때 포함
            </button>
            <button type="button" role="menuitem" data-wiki-context-never onclick={() => changeContextMode('never')}>
                자동 컨텍스트에서 제외
            </button>
        {/if}
        <button type="button" role="menuitem" data-wiki-reveal-file onclick={revealFile}>
            <FolderOpenIcon size={14} /> 탐색기에서 열기
        </button>
    </div>
{/if}

<style>
    .wiki-editor { display: grid; grid-template-columns: minmax(12rem, 17rem) minmax(0, 1fr); min-height: 27rem; border-bottom: 1px solid var(--risu-theme-darkborderc); }
    .file-tree { min-width: 0; overflow: auto; padding: .55rem; border-right: 1px solid var(--risu-theme-darkborderc); background: color-mix(in srgb, var(--risu-theme-darkbg) 96%, black); }
    .tree-toolbar, .editor-toolbar { display: flex; align-items: center; gap: .5rem; }
    .tree-toolbar { justify-content: space-between; padding: .2rem .25rem .6rem; }
    .wiki-health { display: flex; flex-wrap: wrap; gap: .3rem; padding: 0 .25rem .55rem; color: var(--risu-theme-textcolor2); font-size: .65rem; }
    .wiki-health span, .context-badge { border: 1px solid var(--risu-theme-darkborderc); border-radius: 999px; padding: .16rem .38rem; }
    .tree-toolbar strong { color: var(--risu-theme-textcolor2); font: 700 .65rem/1 ui-monospace, monospace; letter-spacing: .16em; }
    .folder-row, .root-file, .folder-children button { width: 100%; display: flex; align-items: center; gap: .4rem; min-width: 0; padding: .38rem .45rem; border-radius: .32rem; color: var(--risu-theme-textcolor); text-align: left; font-size: .74rem; }
    .folder-row { color: var(--risu-theme-textcolor2); font-weight: 700; }
    .folder-row { cursor: pointer; list-style: none; }
    .folder-row.locked { opacity: .72; }
    .folder-children { margin-left: .7rem; padding-left: .35rem; border-left: 1px solid color-mix(in srgb, var(--risu-theme-primary) 20%, var(--risu-theme-darkborderc)); }
    .root-file:hover, .folder-children button:hover, button.active { background: color-mix(in srgb, var(--risu-theme-primary) 13%, transparent); }
    .root-file span, .folder-children span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .editor-pane { min-width: 0; display: flex; flex-direction: column; background: color-mix(in srgb, var(--risu-theme-darkbg) 98%, black); }
    .editor-toolbar { padding: .65rem .75rem; border-bottom: 1px solid var(--risu-theme-darkborderc); }
    .editor-toolbar label { display: grid; gap: .2rem; color: var(--risu-theme-textcolor2); font-size: .62rem; font-weight: 700; }
    .editor-toolbar select, .editor-toolbar input { box-sizing: border-box; min-height: 2rem; padding: .3rem .45rem; border: 1px solid var(--risu-theme-darkborderc); border-radius: .32rem; color: var(--risu-theme-textcolor); background: var(--risu-theme-darkbg); }
    .title-field { min-width: 9rem; flex: 1; }
    .editor-actions { display: flex; align-items: end; gap: .25rem; margin-left: auto; padding-top: .8rem; }
    .document-meta { display: flex; align-items: center; gap: .6rem; padding: .45rem .75rem; color: var(--risu-theme-textcolor2); font-size: .68rem; }
    .readonly-badge, .dirty-badge { padding: .16rem .38rem; border-radius: 999px; }
    .readonly-badge { background: color-mix(in srgb, var(--risu-theme-textcolor2) 14%, transparent); }
    .dirty-badge { color: var(--risu-theme-primary); background: color-mix(in srgb, var(--risu-theme-primary) 14%, transparent); }
    .markdown-editor { flex: 1; min-height: 20rem; resize: none; padding: .9rem 1rem; border: 0; border-top: 1px solid color-mix(in srgb, var(--risu-theme-darkborderc) 60%, transparent); outline: 0; color: var(--risu-theme-textcolor); background: transparent; font: .78rem/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 4; }
    .markdown-editor:focus { box-shadow: inset 3px 0 color-mix(in srgb, var(--risu-theme-primary) 60%, transparent); }
    .markdown-editor[readonly] { opacity: .86; }
    .editor-status { min-height: 1.8rem; padding: .35rem .75rem; color: var(--risu-theme-textcolor2); font-size: .66rem; }
    .error { color: var(--risu-theme-draculared); }
    .success { color: var(--risu-theme-success); }
    .file-context-menu {
        position: fixed;
        z-index: 10000;
        display: grid;
        width: 11rem;
        padding: .28rem;
        border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 28%, var(--risu-theme-darkborderc));
        border-radius: .45rem;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 96%, black);
        box-shadow: 0 .75rem 2rem rgb(0 0 0 / .32);
    }
    .file-context-menu button {
        display: flex;
        align-items: center;
        gap: .5rem;
        padding: .48rem .55rem;
        border: 0;
        border-radius: .3rem;
        color: var(--risu-theme-textcolor);
        background: transparent;
        text-align: left;
        font-size: .74rem;
        cursor: pointer;
    }
    .file-context-menu button:hover,
    .file-context-menu button:focus-visible {
        outline: 0;
        background: color-mix(in srgb, var(--risu-theme-primary) 16%, transparent);
    }
    @media (max-width: 720px) { .wiki-editor { grid-template-columns: 1fr; grid-template-rows: minmax(9rem, 32%) minmax(0, 1fr); } .file-tree { border-right: 0; border-bottom: 1px solid var(--risu-theme-darkborderc); } .editor-toolbar { flex-wrap: wrap; } .editor-actions { width: 100%; margin-left: 0; padding-top: 0; } }
</style>
