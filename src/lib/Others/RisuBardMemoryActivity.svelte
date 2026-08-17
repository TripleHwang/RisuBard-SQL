<script lang="ts">
    import { ActivityIcon, BotIcon, Clock3Icon, DownloadIcon, FileSearchIcon } from '@lucide/svelte'
    import type { Message } from 'src/ts/storage/database.svelte'
    import {
        RISUBARD_MEMORY_ACTIVITY_EVENT,
        getRecentRisuBardMemoryActivity,
        type RisuBardLiveActivity,
    } from 'src/ts/risubard/memoryActivity'
    import {
        addLegacyInputEstimates,
        buildLegacyChatRequestEvidence,
        formatChatRequestEvidenceMarkdown,
        loadChatRequestEvidence,
        type ChatRequestEvidence,
    } from 'src/ts/risubard/chatRequestEvidence'
    import type { RequestLogSource } from 'src/ts/requestLog'
    import type { RequestInjectionKind } from 'src/ts/status/requestStatus'
    import { downloadFile } from 'src/ts/globalApi.svelte'

    interface Props {
        characterId: string
        chatId: string
        messages: Message[]
        onSelectPath?: (path: string) => void
    }

    let { characterId, chatId, messages, onSelectPath }: Props = $props()
    let live = $state<RisuBardLiveActivity[]>([])
    let liveScope = $state('')
    let evidenceExporting = $state<'markdown' | 'json' | ''>('')
    let evidenceExportError = $state('')
    let storedEvidence = $state<ChatRequestEvidence | null>(null)
    let evidenceScope = $state('')
    let generationEntries = $derived(messages.flatMap((message) => {
        const info = message.generationInfo
        return message.role === 'char' && info?.risuBardContext
            ? [{
                messageId: message.chatId ?? info.generationId ?? 'unknown',
                timestamp: message.time,
                info,
            }]
            : []
    }).reverse())
    let requestEntries = $derived(storedEvidence?.requests ?? [])
    let recordedGenerationIds = $derived(new Set(requestEntries.flatMap(
        (entry) => entry.generationId ? [entry.generationId] : []
    )))
    let entries = $derived(generationEntries.filter(
        (entry) => !recordedGenerationIds.has(entry.messageId)
    ))

    const formatNumber = (value: number | null | undefined) =>
        value == null ? '확인 불가' : value.toLocaleString()
    const duration = (timing: Message['generationInfo'] extends infer G
        ? G extends { stageTiming?: infer T } ? T : never
        : never) => {
        if (!timing) return undefined
        return Object.values(timing).reduce(
            (total, value) => total + (typeof value === 'number' ? value : 0),
            0
        )
    }
    const sourceLabels: Record<RequestLogSource, string> = {
        main: '답변 생성',
        memory: '위키 작업',
        'wiki-admin': '위키 관리자 명령',
        translate: '번역',
        emotion: '감정 분석',
        sub: '보조 작업',
        preview: '미리보기',
        test: '테스트',
        tts: '음성 생성',
        image: '이미지 생성',
        plugin: '플러그인 작업',
        other: '기타 요청',
    }
    const injectionLabels: Record<RequestInjectionKind, string> = {
        systemPrompt: '주입 컨텍스트', jailbreak: '탈옥 프롬프트',
        globalNote: '전역 메모', authorNote: '작가 노트', character: '캐릭터',
        persona: '페르소나', lorebook: '로어북', wiki: 'BardWiki',
        memory: '메모리', exampleDialogue: '예시 대화', chatHistory: '채팅 기록',
        instruction: '추가 지침', tool: '도구', other: '기타',
    }
    const formatTimestamp = (value: string | number) =>
        new Date(value).toLocaleString('ko-KR')
    const legacyEvidence = () => buildLegacyChatRequestEvidence(
        chatId,
        generationEntries.map((entry) => ({
            timestamp: entry.timestamp,
            generationId: entry.info.generationId ?? entry.messageId,
            model: entry.info.model,
            inputTokens: entry.info.inputTokens,
            outputTokens: entry.info.outputTokens,
            durationMs: duration(entry.info.stageTiming),
            wikiTokens: entry.info.risuBardContext?.selectedTokens,
        })),
    )

    async function exportRequestEvidence(format: 'markdown' | 'json') {
        if (evidenceExporting) return
        evidenceExporting = format
        evidenceExportError = ''
        try {
            const persisted = await loadChatRequestEvidence(chatId)
            storedEvidence = persisted
            const evidence = persisted.requestCount > 0
                ? persisted
                : legacyEvidence()
            if (evidence.requestCount === 0) {
                evidenceExportError = '이 채팅에 저장된 요청 증거가 없습니다.'
                return
            }
            const evidenceWithLegacy = await addLegacyInputEstimates(evidence, messages)
            const stamp = evidenceWithLegacy.generatedAt.replaceAll(':', '-').replaceAll('.', '-')
            const extension = format === 'markdown' ? 'md' : 'json'
            const content = format === 'markdown'
                ? formatChatRequestEvidenceMarkdown(evidenceWithLegacy)
                : `${JSON.stringify(evidenceWithLegacy, null, 2)}\n`
            await downloadFile(`risubard-chat-evidence-${stamp}.${extension}`, content)
        } catch (error) {
            evidenceExportError = error instanceof Error
                ? error.message
                : '요청 증거 파일을 만들지 못했습니다.'
        } finally {
            evidenceExporting = ''
        }
    }

    $effect(() => {
        const scope = JSON.stringify([characterId, chatId])
        if (liveScope !== scope) {
            liveScope = scope
            live = getRecentRisuBardMemoryActivity(characterId, chatId)
        }
        if (evidenceScope !== chatId) {
            evidenceScope = chatId
            storedEvidence = null
            void (async () => {
                try {
                    const evidence = await loadChatRequestEvidence(chatId)
                    if (evidenceScope === chatId) storedEvidence = evidence
                } catch {
                    // The generation fallback remains available offline.
                }
            })()
        }
        const receive = (event: Event) => {
            const detail = (event as CustomEvent<RisuBardLiveActivity>).detail
            if (detail.characterId !== characterId || detail.chatId !== chatId) return
            live = [detail, ...live].slice(0, 50)
        }
        window.addEventListener(RISUBARD_MEMORY_ACTIVITY_EVENT, receive)
        return () => window.removeEventListener(
            RISUBARD_MEMORY_ACTIVITY_EVENT,
            receive
        )
    })
</script>

<details class="activity-console" open data-memory-activity>
    <summary><ActivityIcon size={15} /> 작업 로그 <span>{requestEntries.length + entries.length + live.length}</span></summary>
    <div class="evidence-toolbar">
        <span>이 채팅의 요청 상태·토큰 구성 증거</span>
        <button
            type="button"
            data-export-request-evidence="markdown"
            disabled={!!evidenceExporting}
            onclick={() => exportRequestEvidence('markdown')}
        ><DownloadIcon size={12} /> Markdown</button>
        <button
            type="button"
            data-export-request-evidence="json"
            disabled={!!evidenceExporting}
            onclick={() => exportRequestEvidence('json')}
        ><DownloadIcon size={12} /> JSON</button>
    </div>
    {#if evidenceExportError}<div class="evidence-error" role="status">{evidenceExportError}</div>{/if}
    <div class="activity-stream">
        {#each live as item (`${item.timestamp}-${item.operation}`)}
            <article class="live-entry">
                <div class="entry-title"><Clock3Icon size={13} /><strong>{item.message}</strong></div>
                <time datetime={new Date(item.timestamp).toISOString()}>{formatTimestamp(item.timestamp)}</time>
                {#if item.wikiPaths?.length}
                    <div class="path-list">
                        {#each item.wikiPaths as path}
                            <button type="button" onclick={() => onSelectPath?.(path)}>{path}</button>
                        {/each}
                    </div>
                {/if}
            </article>
        {/each}
        {#each requestEntries as request (request.id)}
            <article class="request-entry" data-request-source={request.source}>
                <div class="entry-title">
                    <BotIcon size={13} />
                    <span class="request-kind">{sourceLabels[request.source]}</span>
                    <strong>{request.model ?? request.provider ?? '모델 확인 불가'}</strong>
                    <code>{request.generationId ?? `#${request.id}`}</code>
                </div>
                <time datetime={request.timestamp}>{formatTimestamp(request.timestamp)}</time>
                <div class="metrics">
                    <span>결과 {request.outcome === 'done' ? '성공' : request.outcome === 'aborted' ? '중단' : '실패'}</span>
                    <span>입력 {formatNumber(request.inputTokens)}</span>
                    <span>출력 {formatNumber(request.outputTokens)}</span>
                    <span>전체 {formatNumber(request.durationMs)} ms</span>
                    <span>첫 응답 {formatNumber(request.firstTokenMs)} ms</span>
                </div>
                {#if request.injectionManifest}
                    <div class="composition">
                        <b>입력 구성 · {formatNumber(request.injectionManifest.totalTokens)} tokens{request.injectionManifest.estimated ? ' · 추정' : ''}</b>
                        <div class="metrics">
                            {#each request.injectionManifest.items as item}
                                <span>{injectionLabels[item.kind]}{item.name ? ` · ${item.name}` : ''} {formatNumber(item.tokens)}</span>
                            {/each}
                        </div>
                    </div>
                {/if}
            </article>
        {/each}
        {#each entries as entry (entry.messageId)}
            <article class="generation-entry">
                <div class="entry-title"><BotIcon size={13} /><span class="request-kind">답변 생성</span><strong>{entry.info.model ?? '모델 확인 불가'}</strong><code>{entry.messageId}</code></div>
                {#if entry.timestamp}
                    <time datetime={new Date(entry.timestamp).toISOString()}>{formatTimestamp(entry.timestamp)}</time>
                {:else}
                    <time>시각 확인 불가</time>
                {/if}
                <div class="metrics">
                    <span>입력 {formatNumber(entry.info.inputTokens)}</span>
                    <span>출력 {formatNumber(entry.info.outputTokens)}</span>
                    <span>전체 {formatNumber(duration(entry.info.stageTiming))} ms</span>
                    <span>검색 {entry.info.risuBardContext?.inquiryDurationMs ?? 0} ms</span>
                    <span>위키 {entry.info.risuBardContext?.selectedTokens ?? 0} tokens</span>
                    <span>도구 {entry.info.toolUsed ? '사용' : '없음'}</span>
                </div>
                <div class="trace-grid">
                    <div>
                        <b>최근 원문 메시지</b>
                        <div class="chips">
                            {#each entry.info.risuBardContext?.recentMessages ?? [] as recent}
                                <code>{recent.role} · {recent.id}</code>
                            {/each}
                        </div>
                    </div>
                    <div>
                        <b><FileSearchIcon size={12} /> 컨텍스트 문서</b>
                        <div class="path-list">
                            {#each entry.info.risuBardContext?.wikiPaths ?? [] as path}
                                <button type="button" onclick={() => onSelectPath?.(path)}>{path}</button>
                            {:else}
                                <span>선택된 문서 없음</span>
                            {/each}
                        </div>
                    </div>
                </div>
            </article>
        {:else}
            {#if live.length === 0 && requestEntries.length === 0}<div class="empty">이 채팅의 기록된 생성 작업이 없습니다.</div>{/if}
        {/each}
    </div>
</details>

<style>
    .activity-console { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; border-top: 1px solid var(--risu-theme-darkborderc); background: color-mix(in srgb, var(--risu-theme-darkbg) 97%, black); }
    summary { display: flex; align-items: center; gap: .45rem; padding: .6rem .85rem; cursor: pointer; color: var(--risu-theme-textcolor); font-size: .74rem; font-weight: 750; list-style: none; }
    summary span { margin-left: auto; color: var(--risu-theme-textcolor2); font: .68rem ui-monospace, monospace; }
    .evidence-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: .35rem; padding: 0 .75rem .55rem; color: var(--risu-theme-textcolor2); font-size: .64rem; }
    .evidence-toolbar > span { margin-right: auto; }
    .evidence-toolbar button { display: inline-flex; align-items: center; gap: .25rem; padding: .25rem .42rem; border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 26%, var(--risu-theme-darkborderc)); border-radius: .3rem; color: var(--risu-theme-primary); background: color-mix(in srgb, var(--risu-theme-primary) 8%, transparent); font-size: .62rem; }
    .evidence-toolbar button:hover:not(:disabled) { background: color-mix(in srgb, var(--risu-theme-primary) 16%, transparent); }
    .evidence-toolbar button:disabled { opacity: .55; }
    .evidence-error { margin: 0 .75rem .55rem; color: var(--risu-theme-error); font-size: .64rem; }
    .activity-stream { display: grid; flex: 1; align-content: start; min-height: 0; overflow: auto; gap: .45rem; padding: 0 .75rem .75rem; }
    article { display: grid; gap: .42rem; padding: .58rem .65rem; border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 16%, var(--risu-theme-darkborderc)); border-radius: .42rem; background: color-mix(in srgb, var(--risu-theme-darkbg) 94%, transparent); }
    .entry-title, b { display: flex; align-items: center; gap: .38rem; }
    .entry-title code { margin-left: auto; color: var(--risu-theme-textcolor2); font-size: .62rem; }
    .entry-title strong { font-size: .72rem; }
    time, .empty, .path-list span { color: var(--risu-theme-textcolor2); font-size: .65rem; }
    .request-kind { flex: 0 0 auto; padding: .18rem .34rem; border: 1px solid color-mix(in srgb, var(--risu-theme-primary) 34%, transparent); border-radius: 999px; color: var(--risu-theme-primary); background: color-mix(in srgb, var(--risu-theme-primary) 9%, transparent); font-size: .6rem; font-weight: 750; }
    .composition { display: grid; gap: .3rem; padding-top: .1rem; }
    .metrics, .chips, .path-list { display: flex; flex-wrap: wrap; gap: .28rem .5rem; }
    .metrics span, .chips code { padding: .18rem .35rem; border-radius: .25rem; color: var(--risu-theme-textcolor2); background: color-mix(in srgb, var(--risu-theme-textcolor2) 7%, transparent); font-size: .62rem; }
    .trace-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .65rem; }
    .trace-grid > div { display: grid; align-content: start; gap: .3rem; min-width: 0; }
    b { color: var(--risu-theme-textcolor2); font-size: .62rem; text-transform: uppercase; letter-spacing: .04em; }
    .path-list button { max-width: 100%; overflow: hidden; text-overflow: ellipsis; padding: .18rem .35rem; border-radius: .25rem; color: var(--risu-theme-primary); background: color-mix(in srgb, var(--risu-theme-primary) 10%, transparent); font: .62rem ui-monospace, monospace; text-align: left; }
    .path-list button:hover { background: color-mix(in srgb, var(--risu-theme-primary) 18%, transparent); }
    @media (max-width: 640px) { .trace-grid { grid-template-columns: 1fr; } }
</style>
