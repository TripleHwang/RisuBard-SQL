<script lang="ts">
    import {
        LoaderCircleIcon,
        PlayIcon,
        ShieldAlertIcon,
        SquareTerminalIcon,
    } from '@lucide/svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import type { DirectWikiCommandResult } from 'src/ts/risubard/directWikiCommand'

    interface Props {
        onExecute: (instruction: string) => Promise<DirectWikiCommandResult>
    }

    let { onExecute }: Props = $props()
    let instruction = $state('')
    let running = $state(false)
    let error = $state('')
    let result = $state<DirectWikiCommandResult | null>(null)

    async function run() {
        const command = instruction.trim()
        if (!command || running) return
        running = true
        error = ''
        result = null
        try {
            result = await onExecute(command)
        }
        catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            running = false
        }
    }
</script>

<section class="command-terminal" data-wiki-command-terminal>
    <header>
        <span class="terminal-mark"><SquareTerminalIcon size={17} /></span>
        <div>
            <strong>위키 관리자 명령</strong>
            <small>사용자 지시를 최우선으로 현재 Memory Wiki를 직접 편집합니다.</small>
        </div>
        <span class="authority"><ShieldAlertIcon size={13} /> DIRECT</span>
    </header>

    <div class="terminal-body">
        <span class="prompt" aria-hidden="true">›</span>
        <textarea
            data-wiki-command-input
            bind:value={instruction}
            rows="4"
            maxlength="8000"
            placeholder="예: 현 메시지의 프로파일에 언급된 인물들을 각각 character 문서로 만들고, 모든 프로필 정보를 반영해."
            onkeydown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault()
                    void run()
                }
            }}
        ></textarea>
    </div>

    <footer>
        <div class="terminal-status" aria-live="polite" data-wiki-command-result>
            {#if error}
                <span class="failure">실행 실패 · {error}</span>
            {:else if result}
                <span class:failure={result.failed.length > 0}>
                    적용 {result.applied.length}건
                    {#if result.applied.length > 0}
                        · {result.applied.map((item) => item.title).join(', ')}
                    {/if}
                </span>
                {#each result.failed as item}
                    <span class="failure">미적용 · {item.title}: {item.reason}</span>
                {/each}
            {:else}
                <span>Ctrl+Enter로 실행 · 변경 전 history/trash와 hash 충돌 검사는 유지됩니다.</span>
            {/if}
        </div>
        <ShButton
            variant="primary"
            size="sm"
            data-wiki-command-run
            onclick={run}
            disabled={running || !instruction.trim()}
        >
            {#if running}
                <LoaderCircleIcon class="animate-spin" size={14} />
                실행 중
            {:else}
                <PlayIcon size={14} />
                지시 실행
            {/if}
        </ShButton>
    </footer>
</section>

<style>
    .command-terminal {
        --terminal-line: color-mix(in srgb, var(--risu-theme-primary) 34%, transparent);
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        box-sizing: border-box;
        overflow: hidden;
        border: 1px solid var(--terminal-line);
        border-radius: .55rem;
        background:
            linear-gradient(180deg, color-mix(in srgb, var(--risu-theme-primary) 4%, transparent), transparent 38%),
            color-mix(in srgb, var(--risu-theme-darkbg) 96%, black);
        box-shadow: inset 3px 0 0 color-mix(in srgb, var(--risu-theme-primary) 70%, transparent);
    }
    header, footer {
        display: flex;
        align-items: center;
        gap: .65rem;
        padding: .62rem .75rem;
    }
    header { border-bottom: 1px solid var(--terminal-line); }
    footer {
        justify-content: space-between;
        border-top: 1px solid var(--terminal-line);
        background: color-mix(in srgb, var(--risu-theme-primary) 5%, transparent);
    }
    header > div { display: grid; flex: 1; gap: .06rem; min-width: 0; }
    header strong {
        color: var(--risu-theme-textcolor);
        font: 700 .82rem/1.2 ui-monospace, SFMono-Regular, Consolas, monospace;
        letter-spacing: .02em;
    }
    header small, .terminal-status {
        color: var(--risu-theme-textcolor2);
        font-size: .68rem;
    }
    .terminal-mark {
        display: grid;
        place-items: center;
        width: 1.85rem;
        height: 1.85rem;
        border: 1px solid var(--terminal-line);
        border-radius: .35rem;
        color: var(--risu-theme-primary);
        background: color-mix(in srgb, var(--risu-theme-primary) 8%, transparent);
    }
    .authority {
        display: inline-flex;
        align-items: center;
        gap: .25rem;
        padding: .2rem .38rem;
        border: 1px solid color-mix(in srgb, var(--risu-theme-draculared) 45%, transparent);
        border-radius: .25rem;
        color: color-mix(in srgb, var(--risu-theme-draculared) 86%, white);
        font: 700 .58rem/1 ui-monospace, monospace;
        letter-spacing: .08em;
    }
    .terminal-body {
        display: grid;
        flex: 1;
        grid-template-columns: auto minmax(0, 1fr);
        gap: .55rem;
        min-height: 0;
        padding: .75rem;
    }
    .prompt {
        padding-top: .46rem;
        color: var(--risu-theme-primary);
        font: 800 1rem/1 ui-monospace, monospace;
    }
    textarea {
        width: 100%;
        height: 100%;
        min-height: 4.5rem;
        box-sizing: border-box;
        resize: none;
        padding: .5rem .58rem;
        border: 0;
        border-left: 1px solid var(--terminal-line);
        outline: 0;
        color: var(--risu-theme-textcolor);
        background: transparent;
        font: .74rem/1.58 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    textarea::placeholder { color: color-mix(in srgb, var(--risu-theme-textcolor2) 72%, transparent); }
    textarea:focus-visible {
        border-left-color: var(--risu-theme-primary);
        background: color-mix(in srgb, var(--risu-theme-primary) 3%, transparent);
    }
    .terminal-status {
        display: grid;
        gap: .12rem;
        min-width: 0;
    }
    .failure { color: var(--risu-theme-draculared); }
    @media (orientation: portrait) {
        header small, .authority { display: none; }
        footer { align-items: stretch; flex-direction: column; }
        footer :global(button) { justify-content: center; }
        textarea { font-size: 1rem; }
    }
</style>
