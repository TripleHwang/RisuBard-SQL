<script lang="ts">
    import { LocateFixedIcon } from '@lucide/svelte'
    import type { NarrativeMemoryWikiMarkdown } from 'src/ts/risubard/memoryWiki'
    import {
        buildStorySoFar,
        type StorySourceRef,
    } from 'src/ts/risubard/storySoFar'

    interface Props {
        documents: NarrativeMemoryWikiMarkdown['documents']
        onNavigate?: (source: StorySourceRef) => void
    }

    let { documents, onNavigate }: Props = $props()
    let entries = $derived(buildStorySoFar(documents))
</script>

<section class="story-ledger" data-story-so-far aria-label="지금까지의 이야기">
    <header>
        <span>STORY SO FAR</span>
        <h2>지금까지의 이야기</h2>
        <p>확정된 사건만 시간 순서대로 이어 읽습니다.</p>
    </header>

    {#if entries.length === 0}
        <div class="story-empty" data-story-empty>
            아직 기록된 사건이 없습니다.
        </div>
    {:else}
        <ol>
            {#each entries as entry, index (entry.id)}
                <li>
                    <span class="chapter-mark">{String(index + 1).padStart(2, '0')}</span>
                    <button
                        type="button"
                        data-story-entry={entry.id}
                        onclick={() => onNavigate?.(entry.source)}
                        title="원문으로 이동"
                    >
                        <span class="entry-heading">
                            <strong>{entry.title}</strong>
                            <LocateFixedIcon size={15} />
                        </span>
                        {#each entry.summary as item}
                            <span class="story-line">{item}</span>
                        {/each}
                    </button>
                </li>
            {/each}
        </ol>
    {/if}
</section>

<style>
    .story-ledger {
        --story-rule: color-mix(in srgb, var(--risu-theme-primary) 28%, transparent);
        height: 100%;
        overflow: auto;
        padding: clamp(1.2rem, 3vw, 2.5rem);
        background:
            linear-gradient(90deg, transparent 2.65rem, var(--story-rule) 2.65rem, var(--story-rule) calc(2.65rem + 1px), transparent calc(2.65rem + 1px)),
            color-mix(in srgb, var(--risu-theme-bgcolor) 82%, var(--risu-theme-darkbg));
    }
    header { max-width: 46rem; margin: 0 auto 1.8rem; padding-left: 2.6rem; }
    header > span { color: var(--risu-theme-primary); font: 700 .68rem/1.2 ui-monospace, monospace; letter-spacing: .19em; }
    h2 { margin: .35rem 0 .3rem; font-family: Georgia, 'Noto Serif KR', serif; font-size: clamp(1.55rem, 3vw, 2.2rem); font-weight: 600; letter-spacing: -.035em; }
    header p { margin: 0; color: var(--risu-theme-textcolor2); font-size: .84rem; }
    ol { max-width: 46rem; margin: 0 auto; padding: 0; list-style: none; }
    li { position: relative; display: grid; grid-template-columns: 2rem minmax(0, 1fr); gap: .6rem; padding-bottom: 1rem; }
    .chapter-mark { padding-top: .9rem; color: color-mix(in srgb, var(--risu-theme-primary) 75%, var(--risu-theme-textcolor)); font: 700 .67rem/1 ui-monospace, monospace; letter-spacing: .08em; }
    button { width: 100%; padding: .85rem 1rem 1rem; border: 1px solid color-mix(in srgb, var(--risu-theme-borderc) 24%, transparent); border-radius: .28rem; color: var(--risu-theme-textcolor); background: color-mix(in srgb, var(--risu-theme-darkbg) 80%, transparent); box-shadow: 0 .25rem 1.2rem rgb(0 0 0 / .08); text-align: left; cursor: pointer; transition: border-color .16s ease, transform .16s ease, background .16s ease; }
    button:hover, button:focus-visible { border-color: var(--risu-theme-primary); background: color-mix(in srgb, var(--risu-theme-primary) 7%, var(--risu-theme-darkbg)); transform: translateX(.2rem); outline: none; }
    .entry-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: .45rem; color: var(--risu-theme-textcolor2); }
    .entry-heading strong { color: var(--risu-theme-textcolor); font-family: Georgia, 'Noto Serif KR', serif; font-size: .95rem; }
    .story-line { display: block; font-family: Georgia, 'Noto Serif KR', serif; font-size: .9rem; line-height: 1.72; }
    .story-line + .story-line { margin-top: .3rem; }
    .story-empty { max-width: 43.4rem; margin: 2rem auto; padding: 2rem; border: 1px dashed var(--story-rule); color: var(--risu-theme-textcolor2); text-align: center; }
</style>
