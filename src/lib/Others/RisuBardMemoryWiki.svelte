<script lang="ts">
    import {
        BookOpenIcon,
        CircleHelpIcon,
        CheckCircle2Icon,
        Clock3Icon,
        LoaderCircleIcon,
        LogsIcon,
        MilestoneIcon,
        PanelRightCloseIcon,
        NetworkIcon,
        RefreshCwIcon,
        ReplaceAllIcon,
        Rows3Icon,
        SettingsIcon,
        ChevronDownIcon,
        SquareTerminalIcon,
        XCircleIcon,
    } from '@lucide/svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { language } from 'src/lang'
    import { forageStorage } from 'src/ts/globalApi.svelte'
    import {
        normalizeMemoryWikiDockRatio,
        normalizeMemoryWikiWorkspaceHeight,
    } from 'src/ts/risubard/memoryWikiLayout'
    import {
        loadNarrativeMemoryWiki,
        type NarrativeMemoryWiki,
    } from 'src/ts/risubard/memoryWiki'
    import {
        RISUBARD_MEMORY_UPDATED_EVENT,
        type RisuBardMemoryUpdatedDetail,
    } from 'src/ts/risubard/memoryEvents'
    import { DBState } from 'src/ts/stores.svelte'
    import { saveChatToServer } from 'src/ts/storage/chatStorage'
    import {
        applyChatFindReplace,
        replaceWikiText,
    } from 'src/ts/risubard/findReplace'
    import RisuBardNarrativeGraph from './RisuBardNarrativeGraph.svelte'
    import RisuBardWriterWorkbench from './RisuBardWriterWorkbench.svelte'
    import RisuBardWikiEditor from './RisuBardWikiEditor.svelte'
    import RisuBardMemoryActivity from './RisuBardMemoryActivity.svelte'
    import RisuBardStorySoFar from './RisuBardStorySoFar.svelte'
    import RisuBardWikiCommandTerminal from './RisuBardWikiCommandTerminal.svelte'
    import RisuBardFindReplace from './RisuBardFindReplace.svelte'
    import RisuBardMemoryWikiHelp from './RisuBardMemoryWikiHelp.svelte'
    import type { DirectWikiCommandResult } from 'src/ts/risubard/directWikiCommand'
    import type { StorySourceRef } from 'src/ts/risubard/storySoFar'

    interface Props {
        open?: boolean
        characterId: string
        chatId: string
        onForceWikiUpdate?: () => Promise<boolean>
        onExecuteWikiCommand?: (
            instruction: string
        ) => Promise<DirectWikiCommandResult>
        onNavigateStorySource?: (source: StorySourceRef) => void
    }

    let {
        open = $bindable(false),
        characterId,
        chatId,
        onForceWikiUpdate,
        onExecuteWikiCommand,
        onNavigateStorySource,
    }: Props = $props()
    let wiki = $state<NarrativeMemoryWiki | null>(null)
    let loading = $state(false)
    let error = $state('')
    let forceUpdating = $state(false)
    let forceUpdateStatus = $state<'success' | 'empty' | 'failed' | ''>('')
    let forceUpdateError = $state('')
    let requestSequence = 0
    let loadedScope = ''
    let dockElement = $state<HTMLElement | null>(null)
    let workspaceSplitElement = $state<HTMLElement | null>(null)
    let activeView = $state<'workspace' | 'story' | 'replace' | 'log'>('workspace')
    let dockRatio = $state(normalizeMemoryWikiDockRatio(
        DBState.db.risuBardMemoryDockRatio
    ))
    let workspaceHeight = $state(normalizeMemoryWikiWorkspaceHeight(
        DBState.db.risuBardMemoryWorkspaceHeight
    ))
    let commandExpanded = $state(false)
    let editorFocus = $state(false)
    let helpOpen = $state(false)
    let modelMode = $state<'memory' | 'model'>(
        DBState.db.risuBardModelMode === 'model' ? 'model' : 'memory'
    )
    let selectedMarkdownId = $state('')

    let v1State = $derived(wiki?.mode === 'v1' ? wiki.state : null)
    let activeFacts = $derived(
        v1State?.facts.filter((fact) => fact.status === 'active') ?? []
    )
    let invalidatedFacts = $derived(
        v1State?.facts.filter((fact) => fact.status === 'invalidated') ?? []
    )
    let recentEvents = $derived(v1State ? [...v1State.events].reverse() : [])
    let markdownDocuments = $derived(
        wiki?.mode === 'markdown' ? wiki.documents : []
    )
    let activityMessages = $derived(
        DBState.db.characters?.find((character) =>
            character.chaId === characterId
        )?.chats.find((chat) => chat.id === chatId)?.message ?? []
    )
    let empty = $derived(
        wiki?.mode === 'v1'
        && !wiki.baseline
        && activeFacts.length === 0
        && invalidatedFacts.length === 0
        && recentEvents.length === 0
    )

    async function loadWiki() {
        const sequence = ++requestSequence
        const scope = `${characterId}\u0000${chatId}`
        const refreshingCurrentScope = loadedScope === scope
        if (!refreshingCurrentScope) {
            wiki = null
            selectedMarkdownId = ''
        }
        loading = true
        error = ''
        try {
            const loaded = await loadNarrativeMemoryWiki({
                characterId,
                chatId,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            if (sequence === requestSequence) {
                wiki = loaded
                loadedScope = scope
            }
            if (sequence === requestSequence && loaded.mode === 'markdown'
                && !loaded.documents.some((document) =>
                    document.id === selectedMarkdownId
                )) {
                selectedMarkdownId = loaded.documents[0]?.id ?? ''
            }
        }
        catch (cause) {
            if (sequence === requestSequence) {
                wiki = null
                error = cause instanceof Error
                    ? cause.message
                    : String(cause)
            }
        }
        finally {
            if (sequence === requestSequence) loading = false
        }
    }

    async function forceWikiUpdate() {
        if (forceUpdating) return
        forceUpdating = true
        forceUpdateStatus = ''
        forceUpdateError = ''
        try {
            forceUpdateStatus = await onForceWikiUpdate?.()
                ? 'success'
                : 'empty'
        }
        catch (cause) {
            forceUpdateStatus = 'failed'
            forceUpdateError = (cause instanceof Error
                ? cause.message
                : String(cause)).trim().slice(0, 512)
        }
        finally {
            forceUpdating = false
        }
    }

    function saveModelMode(event: Event) {
        modelMode = (event.currentTarget as HTMLSelectElement).value === 'model'
            ? 'model'
            : 'memory'
        DBState.db.risuBardModelMode = modelMode
    }

    function selectMarkdownPath(path: string) {
        const document = markdownDocuments.find((item) =>
            item.relativePath === path
        )
        if (document) selectedMarkdownId = document.id
    }

    async function executeWikiCommand(
        instruction: string
    ): Promise<DirectWikiCommandResult> {
        if (!onExecuteWikiCommand) {
            throw new Error('현재 채팅에서 위키 관리자 명령을 실행할 수 없습니다.')
        }
        const result = await onExecuteWikiCommand(instruction)
        await loadWiki()
        return result
    }

    async function replaceText(input: {
        find: string
        replacement: string
        wiki: boolean
        chat: boolean
    }) {
        let wikiResult = { matches: 0, documents: 0 }
        let chatResult = { matches: 0, messages: 0 }
        const chatTarget = (() => {
            if (!input.chat) return null
            const character = DBState.db.characters?.find((item) =>
                item.chaId === characterId
            )
            const chatIndex = character?.chats.findIndex((item) =>
                item.id === chatId
            ) ?? -1
            const currentChat = chatIndex >= 0
                ? character?.chats[chatIndex]
                : undefined
            if (!character || !currentChat) {
                throw new Error('현재 챗 내역을 찾을 수 없습니다.')
            }
            if (currentChat.isStreaming) {
                throw new Error('답변 생성이 끝난 뒤 챗 내역을 바꿔 주세요.')
            }
            return { character, chatIndex, currentChat }
        })()
        if (input.wiki) {
            wikiResult = await replaceWikiText({
                characterId,
                chatId,
                find: input.find,
                replacement: input.replacement,
                fetchImpl: fetch,
                createAuth: () => forageStorage.createAuth(),
            })
            await loadWiki()
        }
        if (chatTarget) {
            const { character, chatIndex, currentChat } = chatTarget
            const originals = currentChat.message.map((message) => ({
                data: message.data,
                saying: message.saying,
                name: message.name,
                swipes: message.swipes ? [...message.swipes] : undefined,
            }))
            chatResult = applyChatFindReplace(
                currentChat.message,
                input.find,
                input.replacement
            )
            if (chatResult.matches > 0) {
                try {
                    await saveChatToServer(
                        characterId,
                        chatIndex,
                        chatId,
                        currentChat
                    )
                    character.reloadKeys = (character.reloadKeys ?? 0) + 1
                }
                catch (cause) {
                    currentChat.message.forEach((message, index) => {
                        message.data = originals[index].data
                        message.saying = originals[index].saying
                        message.name = originals[index].name
                        message.swipes = originals[index].swipes
                    })
                    throw cause
                }
            }
        }
        return {
            wikiMatches: wikiResult.matches,
            wikiDocuments: wikiResult.documents,
            chatMatches: chatResult.matches,
            chatMessages: chatResult.messages,
        }
    }

    function setDockRatio(value: number) {
        dockRatio = normalizeMemoryWikiDockRatio(value)
        DBState.db.risuBardMemoryDockRatio = dockRatio
    }

    function resizeDock(event: PointerEvent) {
        event.preventDefault()
        const container = dockElement?.parentElement
        if (!container) return
        const update = (move: PointerEvent) => {
            const bounds = container.getBoundingClientRect()
            if (bounds.width <= 0) return
            setDockRatio((bounds.right - move.clientX) / bounds.width)
        }
        const stop = () => {
            window.removeEventListener('pointermove', update)
            window.removeEventListener('pointerup', stop)
        }
        window.addEventListener('pointermove', update)
        window.addEventListener('pointerup', stop, { once: true })
    }

    function resizeDockByKeyboard(event: KeyboardEvent) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        setDockRatio(dockRatio + (event.key === 'ArrowLeft' ? 0.05 : -0.05))
    }

    function availableWorkspaceHeight(): number {
        const height = workspaceSplitElement?.clientHeight ?? 0
        return height > 0 ? height : 10_000
    }

    function setWorkspaceHeight(
        value: number,
        availableHeight = availableWorkspaceHeight()
    ) {
        workspaceHeight = normalizeMemoryWikiWorkspaceHeight(
            value,
            availableHeight
        )
        DBState.db.risuBardMemoryWorkspaceHeight = workspaceHeight
    }

    function resizeWorkspace(event: PointerEvent) {
        event.preventDefault()
        if (!workspaceSplitElement) return
        const bounds = workspaceSplitElement.getBoundingClientRect()
        if (bounds.height <= 0) return
        const update = (move: PointerEvent) => {
            setWorkspaceHeight(move.clientY - bounds.top, bounds.height)
        }
        const stop = () => {
            window.removeEventListener('pointermove', update)
            window.removeEventListener('pointerup', stop)
        }
        window.addEventListener('pointermove', update)
        window.addEventListener('pointerup', stop, { once: true })
    }

    function resizeWorkspaceByKeyboard(event: KeyboardEvent) {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
        event.preventDefault()
        setWorkspaceHeight(
            workspaceHeight + (event.key === 'ArrowDown' ? 24 : -24)
        )
    }

    $effect(() => {
        void open
        if (!characterId || !chatId) return
        void loadWiki()
    })

    $effect(() => {
        if (activeView !== 'workspace') editorFocus = false
    })

    $effect(() => {
        const refreshCompletedAnalysis = (event: Event) => {
            const detail = (event as CustomEvent<
                RisuBardMemoryUpdatedDetail
            >).detail
            if (detail?.characterId !== characterId
                || detail.chatId !== chatId) return
            void loadWiki()
        }
        window.addEventListener(
            RISUBARD_MEMORY_UPDATED_EVENT,
            refreshCompletedAnalysis
        )
        return () => window.removeEventListener(
            RISUBARD_MEMORY_UPDATED_EVENT,
            refreshCompletedAnalysis
        )
    })

</script>

<aside
    class="memory-wiki-dock"
    class:closed={!open}
    class:editor-focus={editorFocus}
    data-memory-wiki-dock
    data-open={open}
    data-editor-focus={editorFocus}
    bind:this={dockElement}
    style:flex-basis={`${dockRatio * 100}%`}
    aria-label={language.risuBardMemoryWiki}
    aria-hidden={!open}
    inert={!open}
>
    <button
        type="button"
        class="dock-resizer"
        aria-label="BardWiki 폭 조절"
        onpointerdown={resizeDock}
        onkeydown={resizeDockByKeyboard}
    ></button>
    <header class="dock-header">
        <div class="dock-identity">
            <span class="dock-mark"><BookOpenIcon size={17} /></span>
            <div class="dock-title-row">
                <strong>{language.risuBardMemoryWiki}</strong>
                <button
                    type="button"
                    class="dock-help"
                    data-memory-help
                    aria-label="리스바드 메모리 도움말"
                    title="리스바드 메모리 도움말"
                    onclick={() => helpOpen = true}
                ><CircleHelpIcon size={15} /></button>
            </div>
        </div>
        <nav class="dock-views" aria-label="BardWiki 보기">
            {#if wiki?.mode === 'markdown'}
                <button
                    type="button"
                    data-risubard-force-wiki-update
                    title={language.risuBardMemoryForceUpdate}
                    onclick={forceWikiUpdate}
                    disabled={forceUpdating || !onForceWikiUpdate}
                >
                    <RefreshCwIcon
                        size={14}
                        class={forceUpdating ? 'animate-spin' : ''}
                    />
                    <span>{forceUpdating
                        ? language.risuBardMemoryForceUpdating
                        : language.risuBardMemoryForceUpdate}</span>
                </button>
            {/if}
            <button
                type="button"
                class:active={activeView === 'workspace'}
                data-memory-view="workspace"
                title="작업 공간"
                onclick={() => activeView = 'workspace'}
            ><Rows3Icon size={14} /><span>작업 공간</span></button>
            {#if wiki?.mode === 'markdown'}
                <button
                    type="button"
                    class:active={activeView === 'story'}
                    data-memory-view="story"
                    title="지금까지의 이야기"
                    onclick={() => activeView = 'story'}
                ><MilestoneIcon size={14} /><span>이야기</span></button>
                <button
                    type="button"
                    class:active={activeView === 'replace'}
                    data-memory-view="replace"
                    title="전체 찾기/바꾸기"
                    onclick={() => activeView = 'replace'}
                ><ReplaceAllIcon size={14} /><span>찾기</span></button>
            {/if}
            <button
                type="button"
                class:active={activeView === 'log'}
                data-memory-view="log"
                title="로그"
                onclick={() => activeView = 'log'}
            ><LogsIcon size={14} /><span>로그</span></button>
            {#if wiki?.mode === 'markdown'}
                <details class="dock-settings">
                    <summary data-memory-settings>
                        <SettingsIcon size={14} /><span>설정</span>
                    </summary>
                    <div class="settings-popover">
                        <label class="memory-model-mode">
                            <span>RisuBard 작업 모델</span>
                            <select data-memory-model-mode value={modelMode} onchange={saveModelMode}>
                                <option value="memory">보조 모델</option>
                                <option value="model">메인 모델</option>
                            </select>
                        </label>
                    </div>
                </details>
            {/if}
        </nav>
        <button class="dock-close" type="button" aria-label="BardWiki 닫기" onclick={() => open = false}>
            <PanelRightCloseIcon size={18} />
        </button>
    </header>

    <div class="memory-ledger min-h-0">
        {#if wiki && wiki.mode !== 'markdown'}
            <div class="ledger-toolbar">
            <div class="ledger-stats" aria-live="polite">
                {#if wiki.mode === 'v2'}
                    <span class="graph-current">
                        <NetworkIcon size={13} />
                        {language.risuBardGraphCurrent}
                    </span>
                    <span>{wiki.graph.nodes.length} {language.risuBardGraphNodes}</span>
                    <span>{wiki.graph.edges.length} {language.risuBardGraphRelations}</span>
                {:else}
                    <span>{activeFacts.length} {language.risuBardActiveFacts}</span>
                    <span>{recentEvents.length} {language.risuBardEvents}</span>
                    <span>{invalidatedFacts.length} {language.risuBardInvalidatedFacts}</span>
                {/if}
            </div>
                <ShButton
                    variant="ghost"
                    size="sm"
                    onclick={loadWiki}
                    disabled={loading}
                >
                    <RefreshCwIcon size={15} class={loading ? 'animate-spin' : ''} />
                    {language.risuBardMemoryRefresh}
                </ShButton>
            </div>
        {/if}
        {#if forceUpdateStatus}
            <div
                class="force-update-status"
                class:failed={forceUpdateStatus === 'failed'}
                data-force-update-status={forceUpdateStatus}
                aria-live="polite"
            >
                {forceUpdateStatus === 'failed' && forceUpdateError
                    ? forceUpdateError
                    : forceUpdateStatus === 'success'
                    ? language.risuBardMemoryForceUpdateDone
                    : forceUpdateStatus === 'empty'
                        ? language.risuBardMemoryForceUpdateEmpty
                        : language.risuBardMemoryForceUpdateFailed}
            </div>
        {/if}
        {#if wiki?.observability}
            <div
                class="memory-observability"
                data-memory-observability
                aria-label="RisuBard runtime observability"
            >
                <span>prompt {wiki.observability.lastPromptMode}</span>
                <span>
                    graph r{wiki.observability.graphRevision}
                    / index r{wiki.observability.indexRevision}
                    ({wiki.observability.cacheStatus})
                </span>
                {#if wiki.observability.lastInquiry}
                    <span>
                        candidates {wiki.observability.lastInquiry.candidateCount}
                        · inspected {wiki.observability.lastInquiry.inspectedNodeCount}
                        nodes / {wiki.observability.lastInquiry.inspectedEdgeCount}
                        edges
                    </span>
                    <span>
                        selected {wiki.observability.lastInquiry.selectedNodeCount}
                        nodes / {wiki.observability.lastInquiry.selectedTokens}
                        tokens
                    </span>
                {/if}
                <span>
                    analysis
                    {wiki.observability.lastAnalysis?.status ?? 'none'}
                    · {wiki.observability.lastAnalysis?.appliedCount ?? 0}
                    operations
                </span>
            </div>
        {/if}

        {#if loading && !wiki}
            <div class="ledger-state">
                <LoaderCircleIcon size={24} class="animate-spin" />
                <span>{language.loading}</span>
            </div>
        {:else if error}
            <div class="ledger-state ledger-error">
                <XCircleIcon size={24} />
                <span>{language.risuBardMemoryLoadFailed}</span>
                <small>{error}</small>
            </div>
        {:else if wiki?.mode === 'markdown'}
            <div
                class="markdown-wiki"
                class:workspace-split={activeView === 'workspace' && !!onExecuteWikiCommand}
                class:command-collapsed={!commandExpanded}
                class:editor-focus={editorFocus}
                class:activity-view={activeView === 'log'}
                data-memory-view-mode="markdown"
                data-wiki-workspace-split={activeView === 'workspace' ? '' : undefined}
                bind:this={workspaceSplitElement}
                style:--wiki-workspace-height={`${workspaceHeight}px`}
            >
                {#if activeView === 'workspace'}
                    <div class="wiki-editor-region">
                        <RisuBardWikiEditor
                            {characterId}
                            {chatId}
                            documents={wiki.documents}
                            health={wiki.health}
                            bind:selectedId={selectedMarkdownId}
                            onChanged={loadWiki}
                            onFocusModeChange={(focused) => editorFocus = focused}
                        />
                    </div>
                    {#if onExecuteWikiCommand}
                        <button
                            type="button"
                            class="workspace-resizer"
                            data-wiki-workspace-resizer
                            aria-label="위키 편집 영역 높이 조절"
                            title="드래그하거나 위·아래 방향키로 편집 영역 높이 조절"
                            onpointerdown={resizeWorkspace}
                            onkeydown={resizeWorkspaceByKeyboard}
                        ><span aria-hidden="true"></span></button>
                        <article
                            class="markdown-command-pane"
                            class:collapsed={!commandExpanded}
                            data-wiki-command-pane
                            data-command-expanded={commandExpanded}
                        >
                            <header class="portrait-command-header">
                                <button
                                    type="button"
                                    data-wiki-toggle-command
                                    aria-expanded={commandExpanded}
                                    aria-controls="risubard-wiki-command-terminal"
                                    onclick={() => commandExpanded = !commandExpanded}
                                >
                                    <SquareTerminalIcon size={17} />
                                    <span>
                                        <strong>위키 관리자 명령</strong>
                                        <small>자연어로 Memory Wiki 편집</small>
                                    </span>
                                    <ChevronDownIcon size={18} class={commandExpanded ? '' : 'collapsed'} />
                                </button>
                            </header>
                            <div id="risubard-wiki-command-terminal" class="command-terminal-region">
                                <RisuBardWikiCommandTerminal
                                    onExecute={executeWikiCommand}
                                />
                            </div>
                        </article>
                    {/if}
                {:else if activeView === 'story'}
                    <RisuBardStorySoFar
                        documents={wiki.documents}
                        onNavigate={onNavigateStorySource}
                    />
                {:else if activeView === 'replace'}
                    <RisuBardFindReplace
                        documents={wiki.documents}
                        messages={activityMessages}
                        onReplace={replaceText}
                    />
                {:else}
                    <div class="activity-log-scroll" data-memory-activity-scroll>
                        <RisuBardMemoryActivity
                            {characterId}
                            {chatId}
                            messages={activityMessages}
                            onSelectPath={(path) => {
                                selectMarkdownPath(path)
                                activeView = 'workspace'
                            }}
                        />
                    </div>
                {/if}
            </div>
        {:else if wiki?.mode === 'v2'}
            <div class="graph-scroll" data-memory-v2-scroll>
                <RisuBardNarrativeGraph graph={wiki.graph} />
                <RisuBardWriterWorkbench
                    graph={wiki.graph}
                    {characterId}
                    {chatId}
                    onApplied={() => loadWiki()}
                />
            </div>
        {:else if empty}
            <div class="ledger-state" data-memory-view-mode="v1">
                <div class="fallback-note">
                    <strong>{language.risuBardMemoryFallback}</strong>
                    <span>{language.risuBardMemoryFallbackDescription}</span>
                </div>
                <BookOpenIcon size={28} />
                <span>{language.risuBardMemoryEmpty}</span>
            </div>
        {:else}
            <div class="ledger-scroll" data-memory-view-mode="v1">
                <div class="fallback-note">
                    <strong>{language.risuBardMemoryFallback}</strong>
                    <span>{language.risuBardMemoryFallbackDescription}</span>
                </div>
                {#if wiki?.baseline}
                    <section class="ledger-section ledger-baseline">
                        <h3>{language.risuBardCurrentSnapshot}</h3>
                        <p>{wiki.baseline}</p>
                    </section>
                {/if}

                <div class="ledger-columns">
                    <section class="ledger-section">
                        <h3>
                            <CheckCircle2Icon size={16} />
                            {language.risuBardActiveFacts}
                        </h3>
                        {#if activeFacts.length === 0}
                            <p class="ledger-muted">{language.none}</p>
                        {:else}
                            <ul>
                                {#each activeFacts as fact (fact.id)}
                                    <li>{fact.text}</li>
                                {/each}
                            </ul>
                        {/if}
                    </section>

                    <section class="ledger-section">
                        <h3>
                            <Clock3Icon size={16} />
                            {language.risuBardEvents}
                        </h3>
                        {#if recentEvents.length === 0}
                            <p class="ledger-muted">{language.none}</p>
                        {:else}
                            <ol>
                                {#each recentEvents as event (event.id)}
                                    <li>{event.summary}</li>
                                {/each}
                            </ol>
                        {/if}
                    </section>
                </div>

                {#if invalidatedFacts.length > 0}
                    <section class="ledger-section ledger-invalidated">
                        <h3>{language.risuBardInvalidatedFacts}</h3>
                        <ul>
                            {#each invalidatedFacts as fact (fact.id)}
                                <li>{fact.text}</li>
                            {/each}
                        </ul>
                    </section>
                {/if}
            </div>
        {/if}
    </div>
</aside>

<RisuBardMemoryWikiHelp bind:open={helpOpen} />

<style>
    .memory-wiki-dock {
        position: relative;
        z-index: 31;
        display: flex;
        flex: 0 0 auto;
        flex-direction: column;
        min-width: min(28rem, 100%);
        max-width: 75%;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        border-left: 1px solid color-mix(in srgb, var(--risu-theme-primary) 28%, var(--risu-theme-darkborderc));
        background: var(--risu-theme-darkbg);
        box-shadow: -.8rem 0 2.4rem rgb(0 0 0 / .18);
        animation: dock-enter .18s ease-out;
        container-type: inline-size;
    }
    .memory-wiki-dock.closed { display: none; }
    .memory-wiki-dock.editor-focus > .dock-header,
    .memory-wiki-dock.editor-focus .ledger-toolbar,
    .memory-wiki-dock.editor-focus .force-update-status,
    .memory-wiki-dock.editor-focus .memory-observability { display: none; }
    .dock-resizer {
        position: absolute;
        z-index: 5;
        inset: 0 auto 0 -.3rem;
        width: .6rem;
        padding: 0;
        border: 0;
        background: transparent;
        cursor: col-resize;
        touch-action: none;
    }
    .dock-resizer::after {
        content: '';
        position: absolute;
        inset: 0 auto 0 .27rem;
        width: 1px;
        background: transparent;
        transition: width .15s ease, background .15s ease;
    }
    .dock-resizer:hover::after,
    .dock-resizer:focus-visible::after {
        width: 3px;
        outline: 0;
        background: var(--risu-theme-primary);
    }
    .dock-header {
        display: flex;
        align-items: center;
        gap: .65rem;
        min-height: 3.3rem;
        padding: .5rem .6rem .5rem .8rem;
        border-bottom: 1px solid var(--risu-theme-darkborderc);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 91%, black);
    }
    .dock-identity {
        display: flex;
        flex: 1 1 8rem;
        min-width: 0;
        align-items: center;
        gap: .55rem;
    }
    .dock-title-row { display: flex; min-width: 0; align-items: center; gap: .28rem; }
    .dock-identity strong { font: 700 .84rem/1.1 Georgia, serif; white-space: nowrap; }
    .dock-help {
        display: inline-grid;
        flex: 0 0 auto;
        width: 1.6rem;
        height: 1.6rem;
        place-items: center;
        padding: 0;
        border: 1px solid transparent;
        border-radius: 999px;
        color: var(--risu-theme-textcolor2);
        background: transparent;
        cursor: pointer;
    }
    .dock-help:hover,
    .dock-help:focus-visible {
        border-color: color-mix(in srgb, var(--risu-theme-primary) 35%, var(--risu-theme-darkborderc));
        outline: 0;
        color: var(--risu-theme-textcolor);
        background: color-mix(in srgb, var(--risu-theme-primary) 12%, transparent);
    }
    .dock-mark {
        display: grid;
        flex: 0 0 auto;
        width: 1.8rem;
        height: 1.8rem;
        place-items: center;
        border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 38%, var(--risu-theme-darkborderc));
        border-radius: .4rem;
        color: var(--risu-theme-primary);
        background: color-mix(in srgb, var(--risu-theme-primary) 9%, transparent);
    }
    .dock-views { display: flex; flex: 0 0 auto; align-items: center; gap: .18rem; margin-left: auto; }
    .dock-views button, .dock-views summary, .dock-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: .32rem;
        min-height: 1.85rem;
        padding: .28rem .48rem;
        border: 1px solid transparent;
        border-radius: .34rem;
        color: var(--risu-theme-textcolor2);
        background: transparent;
        font-size: .68rem;
        white-space: nowrap;
        cursor: pointer;
        list-style: none;
    }
    .dock-views button:hover, .dock-views button.active,
    .dock-views summary:hover, .dock-settings[open] > summary,
    .dock-close:hover {
        color: var(--risu-theme-textcolor);
        border-color: color-mix(in srgb, var(--risu-theme-primary) 24%, var(--risu-theme-darkborderc));
        background: color-mix(in srgb, var(--risu-theme-primary) 12%, transparent);
    }
    .dock-views button.active { color: var(--risu-theme-primary); }
    .dock-views button:disabled { opacity: .48; cursor: default; }
    .dock-settings { position: relative; }
    .settings-popover {
        position: absolute;
        z-index: 50;
        top: calc(100% + .22rem);
        right: 0;
        display: grid;
        min-width: 12rem;
        padding: .55rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .42rem;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 96%, black);
        box-shadow: 0 .6rem 1.5rem rgb(0 0 0 / .28);
    }
    .dock-close { flex: 0 0 auto; padding-inline: .38rem; }
    .memory-ledger {
        display: flex;
        flex: 1;
        flex-direction: column;
        height: auto;
        min-height: 0;
        background:
            linear-gradient(90deg, color-mix(in srgb, var(--risu-theme-primary) 7%, transparent) 1px, transparent 1px),
            linear-gradient(color-mix(in srgb, var(--risu-theme-primary) 5%, transparent) 1px, transparent 1px);
        background-size: 28px 28px;
    }
    .ledger-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 1rem;
        padding: .75rem 1rem;
        border-block: 1px solid var(--risu-theme-darkborderc);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 92%, transparent);
    }
    .ledger-stats {
        display: flex;
        flex-wrap: wrap;
        gap: .5rem;
        color: var(--risu-theme-textcolor2);
        font-size: .72rem;
        letter-spacing: .06em;
        text-transform: uppercase;
    }
    .ledger-stats span {
        display: inline-flex;
        align-items: center;
        gap: .35rem;
        padding: .25rem .5rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 999px;
    }
    .ledger-stats .graph-current {
        color: color-mix(in srgb, var(--risu-theme-primary) 78%, var(--risu-theme-textcolor));
        border-color: color-mix(in srgb, var(--risu-theme-primary) 45%, var(--risu-theme-darkborderc));
    }
    .force-update-status {
        padding: .42rem 1rem;
        border-bottom: 1px solid color-mix(in srgb, var(--risu-theme-success) 28%, var(--risu-theme-darkborderc));
        color: color-mix(in srgb, var(--risu-theme-success) 78%, var(--risu-theme-textcolor));
        background: color-mix(in srgb, var(--risu-theme-success) 8%, var(--risu-theme-darkbg));
        font-size: .7rem;
    }
    .force-update-status.failed {
        border-bottom-color: color-mix(in srgb, var(--risu-theme-draculared) 35%, var(--risu-theme-darkborderc));
        color: var(--risu-theme-draculared);
        background: color-mix(in srgb, var(--risu-theme-draculared) 7%, var(--risu-theme-darkbg));
    }
    .ledger-scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 1rem;
    }
    .graph-scroll {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
    }
    .markdown-wiki {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
    }
    .markdown-wiki.activity-view { overflow: hidden; }
    .activity-log-scroll {
        height: 100%;
        min-height: 0;
        overflow-y: scroll;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
    }
    .activity-log-scroll :global(.activity-console) { height: auto; min-height: 100%; overflow: visible; }
    .activity-log-scroll :global(.activity-stream) { overflow: visible; }
    .markdown-wiki.workspace-split {
        display: grid;
        grid-template-rows:
            minmax(0, min(
                var(--wiki-workspace-height),
                calc(100% - 13.75rem)
            ))
            .75rem
            minmax(13rem, 1fr);
        overflow: hidden;
    }
    .markdown-wiki.workspace-split.editor-focus {
        grid-template-rows: minmax(0, 1fr);
    }
    .workspace-split.editor-focus > .workspace-resizer,
    .workspace-split.editor-focus > .markdown-command-pane { display: none; }
    .wiki-editor-region {
        min-height: 0;
        overflow: hidden;
    }
    .workspace-split .wiki-editor-region :global(.wiki-editor) {
        height: 100%;
        min-height: 0;
        border-bottom: 0;
    }
    .workspace-split .wiki-editor-region :global(.markdown-editor) {
        min-height: 0;
    }
    .workspace-resizer {
        position: relative;
        z-index: 4;
        width: 100%;
        min-height: .75rem;
        padding: 0;
        border: 0;
        border-block: 1px solid var(--risu-theme-darkborderc);
        outline: 0;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 90%, transparent);
        cursor: row-resize;
        touch-action: none;
    }
    .workspace-resizer::before {
        position: absolute;
        z-index: 2;
        inset: -1.9rem 0 0;
        content: '';
    }
    .workspace-resizer span,
    .workspace-resizer::after {
        position: absolute;
        left: 50%;
        width: 2.6rem;
        content: '';
        transform: translateX(-50%);
    }
    .workspace-resizer span {
        top: 50%;
        height: .18rem;
        border-radius: 999px;
        background: color-mix(in srgb, var(--risu-theme-textcolor2) 48%, transparent);
        transform: translate(-50%, -50%);
    }
    .workspace-resizer::after {
        inset-block: -.28rem;
        width: 5rem;
        border-radius: .35rem;
        background: transparent;
        transition: background .14s ease;
    }
    .workspace-resizer:hover,
    .workspace-resizer:focus-visible {
        border-color: color-mix(in srgb, var(--risu-theme-primary) 55%, var(--risu-theme-darkborderc));
        background: color-mix(in srgb, var(--risu-theme-primary) 10%, var(--risu-theme-darkbg));
    }
    .workspace-resizer:hover::after,
    .workspace-resizer:focus-visible::after {
        background: color-mix(in srgb, var(--risu-theme-primary) 9%, transparent);
    }
    .memory-model-mode {
        display: grid;
        gap: .3rem;
        color: var(--risu-theme-textcolor2);
        font-size: .7rem;
    }
    .memory-model-mode select {
        padding: .32rem .4rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .35rem;
        color: var(--risu-theme-textcolor);
        background: var(--risu-theme-darkbg);
    }
    .markdown-command-pane {
        min-height: 0;
        overflow: hidden;
        padding: .65rem .75rem .75rem;
    }
    .portrait-command-header { display: none; }
    .command-terminal-region { height: 100%; min-height: 0; }

    @media (orientation: portrait) {
        .markdown-wiki.workspace-split {
            grid-template-rows:
                minmax(0, min(
                    var(--wiki-workspace-height),
                    calc(100% - 13.8rem)
                ))
                .8rem
                minmax(13rem, 1fr);
        }
        .markdown-wiki.workspace-split.command-collapsed {
            grid-template-rows: minmax(0, 1fr) 0 2.75rem;
        }
        .workspace-split.command-collapsed > .workspace-resizer { display: none; }
        .workspace-resizer { min-height: .8rem; }
        .markdown-command-pane {
            display: grid;
            grid-template-rows: 2.75rem minmax(0, 1fr);
            padding: 0;
            border-top: 1px solid var(--risu-theme-darkborderc);
            background: color-mix(in srgb, var(--risu-theme-darkbg) 94%, black);
        }
        .portrait-command-header {
            display: block;
            min-width: 0;
            border-bottom: 1px solid var(--risu-theme-darkborderc);
        }
        .portrait-command-header > button {
            display: flex;
            width: 100%;
            min-height: 2.75rem;
            align-items: center;
            gap: .6rem;
            padding: .35rem .75rem;
            border: 0;
            color: var(--risu-theme-textcolor);
            background: transparent;
            text-align: left;
            touch-action: manipulation;
        }
        .portrait-command-header > button:active {
            background: color-mix(in srgb, var(--risu-theme-primary) 13%, transparent);
        }
        .portrait-command-header > button:focus-visible {
            outline: 2px solid var(--risu-theme-primary);
            outline-offset: -2px;
        }
        .portrait-command-header button > span {
            display: flex;
            flex: 1;
            min-width: 0;
            align-items: baseline;
            gap: .5rem;
        }
        .portrait-command-header strong { font-size: .78rem; }
        .portrait-command-header small {
            overflow: hidden;
            color: var(--risu-theme-textcolor2);
            font-size: .68rem;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .portrait-command-header :global(svg:last-child) {
            flex: 0 0 auto;
            transition: transform .18s ease-out;
        }
        .portrait-command-header :global(svg:last-child.collapsed) {
            transform: rotate(-90deg);
        }
        .command-terminal-region { padding: .65rem .75rem .75rem; }
        .markdown-command-pane.collapsed .command-terminal-region { display: none; }
        .markdown-wiki.workspace-split.editor-focus {
            grid-template-rows: minmax(0, 1fr);
        }
    }

    @keyframes dock-enter {
        from { opacity: .5; transform: translateX(1rem); }
        to { opacity: 1; transform: translateX(0); }
    }

    @container (max-width: 36rem) {
        .dock-views button { width: 2rem; padding-inline: .35rem; }
        .dock-views button span {
            position: absolute;
            width: 1px;
            height: 1px;
            overflow: hidden;
            clip-path: inset(50%);
            white-space: nowrap;
        }
    }

    @media (max-width: 840px) {
        .memory-wiki-dock {
            position: absolute;
            inset: 0;
            width: 100% !important;
            max-width: none;
            min-width: 0;
        }
        .dock-resizer { display: none; }
        .dock-identity { min-width: 0; }
        .dock-views { margin-left: auto; }
    }

    .memory-observability {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem 0.8rem;
        padding: 0.45rem 0.9rem;
        border-bottom: 1px solid color-mix(in srgb, var(--risu-theme-primary) 16%, transparent);
        color: var(--risu-theme-textcolor2);
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
    }
    .ledger-columns {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 1rem;
        margin-top: 1rem;
    }
    .fallback-note {
        display: grid;
        gap: .2rem;
        margin-bottom: 1rem;
        padding: .7rem .85rem;
        border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 28%, var(--risu-theme-darkborderc));
        border-left: 3px solid var(--risu-theme-primary);
        background: color-mix(in srgb, var(--risu-theme-primary) 7%, var(--risu-theme-darkbg));
        font-size: .72rem;
    }
    .fallback-note span {
        color: var(--risu-theme-textcolor2);
    }
    .ledger-section {
        padding: 1rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .5rem;
        background: color-mix(in srgb, var(--risu-theme-darkbg) 94%, transparent);
        box-shadow: 0 10px 28px rgb(0 0 0 / 12%);
    }
    .ledger-section h3 {
        display: flex;
        align-items: center;
        gap: .45rem;
        margin: 0 0 .75rem;
        color: var(--risu-theme-textcolor);
        font-size: .8rem;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
    }
    .ledger-section p {
        margin: 0;
        white-space: pre-wrap;
        line-height: 1.7;
    }
    .ledger-section ul,
    .ledger-section ol {
        display: grid;
        gap: .65rem;
        margin: 0;
        padding-left: 1.25rem;
    }
    .ledger-section li {
        padding-left: .25rem;
        line-height: 1.55;
    }
    .ledger-baseline {
        border-left: 3px solid var(--risu-theme-primary);
    }
    .ledger-invalidated {
        margin-top: 1rem;
        opacity: .72;
    }
    .ledger-invalidated li {
        text-decoration: line-through;
    }
    .ledger-muted {
        color: var(--risu-theme-textcolor2);
        font-style: italic;
    }
    .ledger-state {
        flex: 1;
        min-height: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: .75rem;
        padding: 2rem;
        color: var(--risu-theme-textcolor2);
        text-align: center;
    }
    .ledger-error {
        color: var(--risu-theme-draculared);
    }
    .ledger-error small {
        max-width: 36rem;
        color: var(--risu-theme-textcolor2);
    }
    @media (max-width: 640px) {
        .ledger-columns {
            grid-template-columns: 1fr;
        }
        .ledger-toolbar {
            align-items: flex-start;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .memory-wiki-dock { animation: none; }
        .portrait-command-header :global(svg:last-child) { transition: none; }
    }
</style>
