<script lang="ts">
    import {
        BookOpenIcon,
        EyeIcon,
        Maximize2Icon,
        NetworkIcon,
        SearchIcon,
    } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { NarrativeNode } from '../../../packages/risubard-core/src/narrativeGraph'
    import {
        createNarrativeGraphProjection,
        MEMORY_GRAPH_EVIDENCE_LIMIT,
        type NarrativeGraphKindFilter,
        type NarrativeGraphStatusFilter,
        type NarrativeGraphViewSnapshot,
    } from 'src/ts/risubard/memoryGraphView'

    interface Props {
        graph: NarrativeGraphViewSnapshot
    }

    let { graph }: Props = $props()
    let query = $state('')
    let kind = $state<NarrativeGraphKindFilter>('all')
    let status = $state<NarrativeGraphStatusFilter>('all')
    let selectedId = $state('')
    let viewMode = $state<'graph' | 'wiki'>('graph')
    let panning = $state(false)
    let panStart: {
        pointerId: number
        clientX: number
        clientY: number
        scrollLeft: number
        scrollTop: number
    } | null = null

    let projection = $derived(createNarrativeGraphProjection(graph, {
        query,
        kind,
        status,
    }))
    let selectedNode = $derived(
        projection.visibleNodes.find((node) => node.id === selectedId)
        ?? projection.visibleNodes[0]
        ?? null
    )
    let selectedEdges = $derived(
        selectedNode
            ? projection.visibleEdges.filter((edge) =>
                edge.sourceId === selectedNode?.id
                || edge.targetId === selectedNode?.id
            )
            : []
    )
    let selectedEvidence = $derived(
        selectedNode?.evidence.slice(0, MEMORY_GRAPH_EVIDENCE_LIMIT) ?? []
    )
    let wikiGroups = $derived(
        (['entity', 'event', 'state', 'claim', 'thread'] as const)
            .map((groupKind) => ({
                kind: groupKind,
                nodes: projection.visibleNodes.filter(
                    (node) => node.kind === groupKind
                ),
            }))
            .filter((group) => group.nodes.length > 0)
    )

    function displayPerspective(node: NarrativeNode): string {
        return node.perspective.kind === 'omniscient'
            ? 'omniscient'
            : node.perspective.entityId
    }

    function titleFor(nodeId: string): string {
        return graph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId
    }

    function kindLabel(kind: NarrativeNode['kind']): string {
        if (kind === 'entity') return language.risuBardGraphCharacters
        if (kind === 'event') return language.risuBardEvents
        if (kind === 'state') return language.risuBardGraphStates
        if (kind === 'claim') return language.risuBardGraphClaims
        return language.risuBardGraphThreads
    }

    function centerCanvas(event: MouseEvent): void {
        const viewport = (event.currentTarget as Element)
            .closest('.graph-observatory')
            ?.querySelector<HTMLElement>('[data-memory-graph-viewport]')
        if (!viewport) return
        viewport.scrollLeft = Math.max(
            0,
            (viewport.scrollWidth - viewport.clientWidth) / 2
        )
        viewport.scrollTop = Math.max(
            0,
            (viewport.scrollHeight - viewport.clientHeight) / 2
        )
    }

    function beginPan(event: PointerEvent): void {
        if (event.button !== 0) return
        if (event.target instanceof Element
            && event.target.closest('[data-memory-node-id]')) {
            return
        }
        const viewport = event.currentTarget as HTMLDivElement
        panStart = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            scrollLeft: viewport.scrollLeft,
            scrollTop: viewport.scrollTop,
        }
        panning = true
        viewport.setPointerCapture?.(event.pointerId)
    }

    function movePan(event: PointerEvent): void {
        if (!panStart
            || event.pointerId !== panStart.pointerId) {
            return
        }
        const viewport = event.currentTarget as HTMLDivElement
        viewport.scrollLeft = panStart.scrollLeft
            - (event.clientX - panStart.clientX)
        viewport.scrollTop = panStart.scrollTop
            - (event.clientY - panStart.clientY)
    }

    function endPan(event: PointerEvent): void {
        if (!panStart
            || event.pointerId !== panStart.pointerId) {
            return
        }
        const viewport = event.currentTarget as HTMLDivElement
        viewport.releasePointerCapture?.(event.pointerId)
        panStart = null
        panning = false
    }
</script>

<section
    class="graph-observatory"
    aria-label="Narrative graph"
    data-memory-view-mode="v2"
>
    <header class="graph-controls">
        <label class="graph-search">
            <SearchIcon size={15} aria-hidden="true" />
            <span class="sr-only">{language.risuBardGraphSearchLabel}</span>
            <input
                bind:value={query}
                type="search"
                placeholder={language.risuBardGraphSearch}
            />
        </label>
        <label>
            <span class="sr-only">{language.risuBardGraphKindLabel}</span>
            <select bind:value={kind} aria-label={language.risuBardGraphKindLabel}>
                <option value="all">{language.risuBardGraphAllKinds}</option>
                <option value="entity">{language.risuBardGraphCharacters}</option>
                <option value="event">{language.risuBardEvents}</option>
                <option value="state">{language.risuBardGraphStates}</option>
                <option value="claim">{language.risuBardGraphClaims}</option>
                <option value="thread">{language.risuBardGraphThreads}</option>
            </select>
        </label>
        <label>
            <span class="sr-only">{language.risuBardGraphStatusLabel}</span>
            <select bind:value={status} aria-label={language.risuBardGraphStatusLabel}>
                <option value="all">{language.risuBardGraphAllStatus}</option>
                <option value="active">{language.risuBardGraphActive}</option>
                <option value="resolved">{language.risuBardGraphResolved}</option>
                <option value="invalidated">{language.risuBardGraphInvalidated}</option>
                <option value="superseded">{language.risuBardGraphSuperseded}</option>
            </select>
        </label>
        <div class="graph-revision" title="Graph revision">
            <NetworkIcon size={14} aria-hidden="true" />
            r{graph.revision}
        </div>
    </header>

    <div class="graph-summary" aria-live="polite">
        <span>
            {projection.visibleNodes.length}/{projection.totalNodeCount}
            nodes
        </span>
        <span>
            {projection.visibleEdges.length}/{projection.totalEdgeCount}
            relations
        </span>
        {#if projection.truncated}
            <strong>{language.risuBardGraphBounded}</strong>
        {/if}
    </div>

    <div class="view-strip">
        <div class="view-tabs" role="tablist" aria-label="Memory view">
            <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'graph'}
                data-memory-view-toggle="graph"
                class:active={viewMode === 'graph'}
                onclick={() => { viewMode = 'graph' }}
            >
                <NetworkIcon size={14} aria-hidden="true" />
                {language.risuBardGraphMapView}
            </button>
            <button
                type="button"
                role="tab"
                aria-selected={viewMode === 'wiki'}
                data-memory-view-toggle="wiki"
                class:active={viewMode === 'wiki'}
                onclick={() => { viewMode = 'wiki' }}
            >
                <BookOpenIcon size={14} aria-hidden="true" />
                {language.risuBardGraphWikiView}
            </button>
        </div>
        {#if viewMode === 'graph'}
            <div class="pan-tools">
                <span>{language.risuBardGraphPanHint}</span>
                <button
                    type="button"
                    data-memory-graph-center
                    onclick={centerCanvas}
                    title={language.risuBardGraphCenter}
                    aria-label={language.risuBardGraphCenter}
                >
                    <Maximize2Icon size={14} aria-hidden="true" />
                </button>
            </div>
        {/if}
    </div>

    <div class="graph-workbench">
        {#if viewMode === 'graph'}
            <div
                class="constellation-frame"
                class:panning
                data-memory-graph-viewport
                role="group"
                aria-label={language.risuBardGraphPanHint}
                onpointerdown={beginPan}
                onpointermove={movePan}
                onpointerup={endPan}
                onpointercancel={endPan}
            >
                <div
                    class="constellation"
                    role="group"
                    aria-label="Narrative nodes"
                    style={`--lane-count:${projection.laneCount}`}
                >
                    <svg
                        class="relation-layer"
                        viewBox="0 0 100 100"
                        preserveAspectRatio="none"
                        aria-hidden="true"
                    >
                        {#each projection.visibleEdges as edge (edge.id)}
                            {@const source = projection.visibleNodes.find(
                                (node) => node.id === edge.sourceId
                            )}
                            {@const target = projection.visibleNodes.find(
                                (node) => node.id === edge.targetId
                            )}
                            {#if source && target}
                                <line
                                    data-memory-edge-id={edge.id}
                                    class:selected={
                                        selectedNode?.id === edge.sourceId
                                        || selectedNode?.id === edge.targetId
                                    }
                                    x1={source.x}
                                    y1={source.y}
                                    x2={target.x}
                                    y2={target.y}
                                />
                            {/if}
                        {/each}
                    </svg>

                    {#each projection.visibleNodes as node, index (node.id)}
                        <button
                            type="button"
                            data-memory-node-id={node.id}
                            class="memory-node kind-{node.kind}"
                            class:selected={selectedNode?.id === node.id}
                            class:inactive={node.status !== 'active'}
                            style={`--x:${node.x}%;--y:${node.y}%;--delay:${Math.min(index, 12) * 24}ms`}
                            aria-pressed={selectedNode?.id === node.id}
                            aria-label={`${node.kind}: ${node.title}`}
                            onclick={() => { selectedId = node.id }}
                        >
                            <span class="node-kind">{node.kind}</span>
                            <strong>{node.title}</strong>
                            <small>{node.subtype ?? node.status}</small>
                        </button>
                    {/each}

                    {#if projection.visibleNodes.length === 0}
                        <div class="graph-empty">
                            <SearchIcon size={24} aria-hidden="true" />
                            <span>{language.risuBardGraphNoMatches}</span>
                        </div>
                    {/if}
                </div>
            </div>
        {:else}
            <nav
                class="wiki-browser"
                data-memory-wiki-index
                aria-label={language.risuBardGraphWikiIndex}
            >
                {#each wikiGroups as group (group.kind)}
                    <section class="wiki-group">
                        <h3>
                            <span>{kindLabel(group.kind)}</span>
                            <small>{group.nodes.length}</small>
                        </h3>
                        <div class="wiki-node-list">
                            {#each group.nodes as node (node.id)}
                                <button
                                    type="button"
                                    data-memory-wiki-node={node.id}
                                    class:selected={selectedNode?.id === node.id}
                                    onclick={() => { selectedId = node.id }}
                                >
                                    <span class="wiki-node-mark kind-{node.kind}">
                                        {node.kind.slice(0, 1)}
                                    </span>
                                    <span class="wiki-node-copy">
                                        <strong>{node.title}</strong>
                                        <small>
                                            {node.subtype ?? node.status}
                                            · {node.connectedCount}
                                            {language.risuBardGraphRelations}
                                        </small>
                                    </span>
                                </button>
                            {/each}
                        </div>
                    </section>
                {/each}
                {#if projection.visibleNodes.length === 0}
                    <div class="graph-empty">
                        <SearchIcon size={24} aria-hidden="true" />
                        <span>{language.risuBardGraphNoMatches}</span>
                    </div>
                {/if}
            </nav>
        {/if}

        <aside class="node-inspector" data-memory-node-detail>
            {#if selectedNode}
                <div class="inspector-kicker">
                    <span>{selectedNode.kind}/{selectedNode.subtype}</span>
                    <span class="status-dot status-{selectedNode.status}">
                        {selectedNode.status}
                    </span>
                </div>
                <h3>{selectedNode.title}</h3>
                <p class="node-summary">{selectedNode.summary}</p>

                <dl>
                    <div>
                        <dt>{language.risuBardGraphPerspective}</dt>
                        <dd>{displayPerspective(selectedNode)}</dd>
                    </div>
                    <div>
                        <dt>{language.risuBardGraphEpistemic}</dt>
                        <dd>{selectedNode.epistemic}</dd>
                    </div>
                    <div>
                        <dt>{language.risuBardGraphSalience}</dt>
                        <dd>{selectedNode.salience}/10</dd>
                    </div>
                    <div>
                        <dt>{language.risuBardGraphRevision}</dt>
                        <dd>{selectedNode.revision}</dd>
                    </div>
                </dl>

                <section class="inspector-section">
                    <h4>Relations · {selectedEdges.length}</h4>
                    {#if selectedEdges.length > 0}
                        <ul class="relation-list">
                            {#each selectedEdges as edge (edge.id)}
                                <li>
                                    <span>{edge.type}</span>
                                    <strong>
                                        {titleFor(
                                            edge.sourceId === selectedNode.id
                                                ? edge.targetId
                                                : edge.sourceId
                                        )}
                                    </strong>
                                </li>
                            {/each}
                        </ul>
                    {:else}
                        <p class="inspector-muted">{language.risuBardGraphNoRelations}</p>
                    {/if}
                </section>

                <section class="inspector-section" data-memory-node-evidence>
                    <h4>
                        <EyeIcon size={13} aria-hidden="true" />
                        {language.risuBardGraphEvidence} ·
                        {selectedEvidence.length} / {selectedNode.evidence.length}
                    </h4>
                    <ul class="evidence-list">
                        {#each selectedEvidence as evidence}
                            <li>{evidence.messageId}</li>
                        {/each}
                    </ul>
                </section>
            {:else}
                <div class="inspector-empty">
                    {language.risuBardGraphSelectNode}
                </div>
            {/if}
        </aside>
    </div>
</section>

<style>
    .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
    }
    .graph-observatory {
        --graph-ink: var(--risu-theme-textcolor);
        --graph-muted: var(--risu-theme-textcolor2);
        --graph-line: color-mix(in srgb, var(--risu-theme-primary) 24%, transparent);
        color: var(--graph-ink);
    }
    .graph-controls {
        display: grid;
        grid-template-columns: minmax(12rem, 1fr) auto auto auto;
        align-items: center;
        gap: .55rem;
        padding: .7rem .85rem;
        border-bottom: 1px solid var(--risu-theme-darkborderc);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 94%, transparent);
    }
    .graph-search {
        display: flex;
        align-items: center;
        gap: .5rem;
        min-width: 0;
        padding: .45rem .65rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .35rem;
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 55%, transparent);
    }
    .graph-search:focus-within {
        border-color: var(--risu-theme-primary);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--risu-theme-primary) 18%, transparent);
    }
    .graph-search input {
        width: 100%;
        min-width: 0;
        border: 0;
        outline: 0;
        color: inherit;
        background: transparent;
        font: inherit;
    }
    .graph-controls select {
        min-height: 2.15rem;
        padding: .4rem 1.8rem .4rem .6rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .35rem;
        color: inherit;
        background: var(--risu-theme-darkbg);
        font-size: .76rem;
    }
    .graph-revision {
        display: flex;
        align-items: center;
        gap: .35rem;
        color: var(--graph-muted);
        font: 700 .68rem/1 monospace;
        letter-spacing: .08em;
    }
    .graph-summary {
        display: flex;
        flex-wrap: wrap;
        gap: .8rem;
        padding: .5rem .85rem;
        color: var(--graph-muted);
        border-bottom: 1px solid var(--risu-theme-darkborderc);
        font: 650 .66rem/1.2 monospace;
        letter-spacing: .06em;
        text-transform: uppercase;
    }
    .graph-summary strong {
        color: color-mix(in srgb, var(--risu-theme-primary) 70%, var(--graph-ink));
        font-weight: 700;
    }
    .view-strip {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: .75rem;
        padding: .45rem .75rem;
        border-bottom: 1px solid var(--risu-theme-darkborderc);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 96%, transparent);
    }
    .view-tabs {
        display: inline-flex;
        gap: .2rem;
        padding: .18rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .4rem;
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 35%, transparent);
    }
    .view-tabs button,
    .pan-tools button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: .35rem;
        border: 0;
        border-radius: .28rem;
        color: var(--graph-muted);
        background: transparent;
        cursor: pointer;
    }
    .view-tabs button {
        padding: .35rem .55rem;
        font-size: .68rem;
        font-weight: 700;
    }
    .view-tabs button.active {
        color: var(--graph-ink);
        background: color-mix(in srgb, var(--risu-theme-primary) 16%, var(--risu-theme-darkbg));
        box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--risu-theme-primary) 34%, transparent);
    }
    .view-tabs button:focus-visible,
    .pan-tools button:focus-visible {
        outline: 2px solid color-mix(in srgb, var(--risu-theme-primary) 65%, transparent);
        outline-offset: 2px;
    }
    .pan-tools {
        display: flex;
        align-items: center;
        gap: .5rem;
        color: var(--graph-muted);
        font-size: .62rem;
    }
    .pan-tools button {
        width: 1.8rem;
        height: 1.8rem;
        border: 1px solid var(--risu-theme-darkborderc);
    }
    .graph-workbench {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 18rem;
        min-height: 33rem;
    }
    .constellation-frame {
        min-width: 0;
        overflow: auto;
        border-right: 1px solid var(--risu-theme-darkborderc);
        cursor: grab;
        touch-action: none;
        user-select: none;
        overscroll-behavior: contain;
    }
    .constellation-frame.panning {
        cursor: grabbing;
    }
    .constellation {
        position: relative;
        min-width: max(42rem, calc(var(--lane-count) * 9.5rem));
        min-height: 33rem;
        overflow: hidden;
        background:
            radial-gradient(circle at center, transparent 0 13%, var(--graph-line) 13.2% 13.4%, transparent 13.6% 27%, var(--graph-line) 27.2% 27.4%, transparent 27.6%),
            linear-gradient(90deg, var(--graph-line) 1px, transparent 1px),
            linear-gradient(var(--graph-line) 1px, transparent 1px),
            color-mix(in srgb, var(--risu-theme-darkbg) 88%, var(--color-bgcolor));
        background-size: auto, 32px 32px, 32px 32px, auto;
    }
    .constellation::after {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: linear-gradient(115deg, transparent 35%, color-mix(in srgb, var(--risu-theme-primary) 6%, transparent), transparent 65%);
    }
    .relation-layer {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        overflow: visible;
    }
    .relation-layer line {
        stroke: color-mix(in srgb, var(--risu-theme-textcolor2) 36%, transparent);
        stroke-width: .22;
        vector-effect: non-scaling-stroke;
        transition: stroke .18s ease, stroke-width .18s ease;
    }
    .relation-layer line.selected {
        stroke: var(--risu-theme-primary);
        stroke-width: .42;
    }
    .memory-node {
        --node-accent: var(--risu-theme-primary);
        position: absolute;
        z-index: 2;
        left: var(--x);
        top: var(--y);
        width: 7.25rem;
        min-height: 3.35rem;
        padding: .42rem .5rem .45rem;
        transform: translate(-50%, -50%);
        border: 1px solid color-mix(in srgb, var(--node-accent) 46%, var(--risu-theme-darkborderc));
        border-left-width: 3px;
        border-radius: .28rem;
        color: var(--graph-ink);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 90%, var(--color-bgcolor));
        box-shadow: 0 .6rem 1.2rem color-mix(in srgb, var(--color-shadow) 24%, transparent);
        text-align: left;
        cursor: pointer;
        opacity: 0;
        animation: chart-node-in .32s ease forwards;
        animation-delay: var(--delay);
        transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease;
    }
    .memory-node:hover,
    .memory-node:focus-visible {
        z-index: 4;
        transform: translate(-50%, -50%) scale(1.05);
        outline: none;
        border-color: var(--node-accent);
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--node-accent) 20%, transparent), 0 1rem 2rem color-mix(in srgb, var(--color-shadow) 32%, transparent);
    }
    .memory-node.selected {
        z-index: 3;
        border-color: var(--node-accent);
        background: color-mix(in srgb, var(--node-accent) 13%, var(--risu-theme-darkbg));
        box-shadow: 0 0 0 2px color-mix(in srgb, var(--node-accent) 26%, transparent), 0 1rem 2rem color-mix(in srgb, var(--color-shadow) 28%, transparent);
    }
    .memory-node.inactive {
        opacity: .64;
        filter: saturate(.55);
    }
    .memory-node.kind-entity { --node-accent: var(--color-success); }
    .memory-node.kind-event { --node-accent: var(--color-warning); }
    .memory-node.kind-state { --node-accent: var(--color-info); }
    .memory-node.kind-claim { --node-accent: var(--color-danger); }
    .memory-node.kind-thread { --node-accent: var(--color-secondary); }
    .memory-node span,
    .memory-node small {
        display: block;
    }
    .node-kind {
        color: var(--node-accent);
        font: 750 .54rem/1 monospace;
        letter-spacing: .11em;
        text-transform: uppercase;
    }
    .memory-node strong {
        display: -webkit-box;
        margin-top: .25rem;
        overflow: hidden;
        font-size: .72rem;
        line-height: 1.15;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        line-clamp: 2;
    }
    .memory-node small {
        margin-top: .25rem;
        overflow: hidden;
        color: var(--graph-muted);
        font: .56rem/1 monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .wiki-browser {
        position: relative;
        min-width: 0;
        max-height: 33rem;
        padding: .9rem;
        overflow: auto;
        border-right: 1px solid var(--risu-theme-darkborderc);
        background:
            linear-gradient(90deg, color-mix(in srgb, var(--risu-theme-primary) 5%, transparent) 1px, transparent 1px),
            color-mix(in srgb, var(--risu-theme-darkbg) 91%, var(--color-bgcolor));
        background-size: 28px 28px, auto;
    }
    .wiki-group + .wiki-group {
        margin-top: 1rem;
    }
    .wiki-group h3 {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 0 0 .45rem;
        color: var(--graph-muted);
        font: 750 .62rem/1 monospace;
        letter-spacing: .1em;
        text-transform: uppercase;
    }
    .wiki-group h3 small {
        padding: .15rem .35rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 999px;
        font-size: .55rem;
    }
    .wiki-node-list {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
        gap: .4rem;
    }
    .wiki-node-list button {
        display: grid;
        grid-template-columns: 1.7rem minmax(0, 1fr);
        gap: .55rem;
        align-items: center;
        min-width: 0;
        padding: .55rem .6rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: .3rem;
        color: var(--graph-ink);
        background: color-mix(in srgb, var(--risu-theme-darkbg) 91%, transparent);
        text-align: left;
        cursor: pointer;
        transition: border-color .15s ease, background .15s ease, transform .15s ease;
    }
    .wiki-node-list button:hover,
    .wiki-node-list button:focus-visible {
        outline: none;
        border-color: color-mix(in srgb, var(--risu-theme-primary) 62%, var(--risu-theme-darkborderc));
        transform: translateY(-1px);
    }
    .wiki-node-list button.selected {
        border-color: var(--risu-theme-primary);
        background: color-mix(in srgb, var(--risu-theme-primary) 10%, var(--risu-theme-darkbg));
        box-shadow: inset 3px 0 0 var(--risu-theme-primary);
    }
    .wiki-node-mark {
        display: grid;
        width: 1.7rem;
        height: 1.7rem;
        place-items: center;
        border: 1px solid currentColor;
        border-radius: 50%;
        color: var(--risu-theme-primary);
        font: 800 .65rem/1 monospace;
        text-transform: uppercase;
    }
    .wiki-node-mark.kind-entity { color: var(--color-success); }
    .wiki-node-mark.kind-event { color: var(--color-warning); }
    .wiki-node-mark.kind-state { color: var(--color-info); }
    .wiki-node-mark.kind-claim { color: var(--color-danger); }
    .wiki-node-mark.kind-thread { color: var(--color-secondary); }
    .wiki-node-copy {
        min-width: 0;
    }
    .wiki-node-copy strong,
    .wiki-node-copy small {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .wiki-node-copy strong {
        font-size: .74rem;
    }
    .wiki-node-copy small {
        margin-top: .22rem;
        color: var(--graph-muted);
        font: .57rem/1.2 monospace;
    }
    .node-inspector {
        padding: 1rem;
        overflow-y: auto;
        background:
            linear-gradient(180deg, color-mix(in srgb, var(--risu-theme-primary) 7%, transparent), transparent 9rem),
            var(--risu-theme-darkbg);
    }
    .inspector-kicker {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: .5rem;
        color: var(--graph-muted);
        font: 700 .59rem/1 monospace;
        letter-spacing: .08em;
        text-transform: uppercase;
    }
    .status-dot {
        padding: .2rem .38rem;
        border: 1px solid var(--risu-theme-darkborderc);
        border-radius: 999px;
    }
    .status-active { color: var(--color-success); }
    .status-invalidated { color: var(--risu-theme-draculared); }
    .node-inspector h3 {
        margin: .75rem 0 .45rem;
        font-family: Georgia, 'Times New Roman', serif;
        font-size: 1.35rem;
        line-height: 1.15;
    }
    .node-summary {
        margin: 0;
        color: var(--graph-muted);
        font-size: .82rem;
        line-height: 1.6;
        white-space: pre-wrap;
    }
    .node-inspector dl {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: .5rem;
        margin: 1rem 0;
    }
    .node-inspector dl div {
        min-width: 0;
        padding: .5rem;
        border: 1px solid var(--risu-theme-darkborderc);
        background: color-mix(in srgb, var(--risu-theme-bgcolor) 30%, transparent);
    }
    .node-inspector dt {
        color: var(--graph-muted);
        font: 650 .56rem/1 monospace;
        letter-spacing: .06em;
        text-transform: uppercase;
    }
    .node-inspector dd {
        margin: .35rem 0 0;
        overflow-wrap: anywhere;
        font-size: .7rem;
    }
    .inspector-section {
        margin-top: 1rem;
        padding-top: .8rem;
        border-top: 1px solid var(--risu-theme-darkborderc);
    }
    .inspector-section h4 {
        display: flex;
        align-items: center;
        gap: .35rem;
        margin: 0 0 .55rem;
        color: var(--graph-muted);
        font: 700 .6rem/1 monospace;
        letter-spacing: .08em;
        text-transform: uppercase;
    }
    .relation-list,
    .evidence-list {
        display: grid;
        gap: .35rem;
        margin: 0;
        padding: 0;
        list-style: none;
    }
    .relation-list li {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: .45rem;
        align-items: baseline;
        font-size: .68rem;
    }
    .relation-list span {
        color: var(--risu-theme-primary);
        font: 650 .56rem/1 monospace;
    }
    .relation-list strong {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .evidence-list li {
        overflow: hidden;
        color: var(--graph-muted);
        font: .61rem/1.35 monospace;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .inspector-muted,
    .inspector-empty {
        color: var(--graph-muted);
        font-size: .72rem;
    }
    .graph-empty {
        position: absolute;
        inset: 0;
        display: grid;
        place-content: center;
        justify-items: center;
        gap: .6rem;
        color: var(--graph-muted);
        font-size: .78rem;
    }
    @keyframes chart-node-in {
        from {
            opacity: 0;
            transform: translate(-50%, -45%) scale(.96);
        }
        to {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
        }
    }
    @media (prefers-reduced-motion: reduce) {
        .memory-node {
            opacity: 1;
            animation: none;
            transition: none;
        }
    }
    @media (max-width: 800px) {
        .graph-controls {
            grid-template-columns: 1fr 1fr;
        }
        .graph-search {
            grid-column: 1 / -1;
        }
        .graph-workbench {
            grid-template-columns: 1fr;
        }
        .constellation-frame {
            border-right: 0;
            border-bottom: 1px solid var(--risu-theme-darkborderc);
        }
        .wiki-browser {
            border-right: 0;
            border-bottom: 1px solid var(--risu-theme-darkborderc);
        }
        .constellation {
            min-height: 27rem;
        }
        .node-inspector {
            max-height: 24rem;
        }
        .pan-tools span {
            display: none;
        }
    }
</style>
