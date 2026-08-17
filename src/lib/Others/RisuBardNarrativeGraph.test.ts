// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type {
    NarrativeGraphStateV2,
    NarrativeNode,
} from '../../../packages/risubard-core/src/narrativeGraph'
import RisuBardNarrativeGraph from './RisuBardNarrativeGraph.svelte'

let mounted: ReturnType<typeof mount> | undefined

function node(
    id: string,
    kind: NarrativeNode['kind'],
    title: string
): NarrativeNode {
    return {
        id,
        kind,
        subtype: kind === 'claim' ? 'belief' : kind === 'entity'
            ? 'character'
            : undefined,
        title,
        summary: `${title} summary`,
        storyId: 'character',
        branchId: 'chat',
        status: 'active',
        authority: 'draft',
        salience: 5,
        perspective: kind === 'claim'
            ? { kind: 'character', entityId: 'entity:lina' }
            : { kind: 'omniscient' },
        epistemic: kind === 'claim' ? 'belief' : 'fact',
        evidence: [{ chatId: 'chat', messageId: 'message-1' }],
        revision: 1,
    } as NarrativeNode
}

function graph(): NarrativeGraphStateV2 {
    return {
        schemaVersion: 2,
        storyId: 'character',
        branchId: 'chat',
        revision: 4,
        nodes: [
            node('entity:lina', 'entity', 'Lina'),
            node('claim:oath', 'claim', 'Hidden oath'),
            node('event:arrival', 'event', 'Arrival'),
        ],
        edges: [{
            id: 'edge:belief-holder',
            sourceId: 'claim:oath',
            type: 'believed_by',
            targetId: 'entity:lina',
            storyId: 'character',
            branchId: 'chat',
            evidence: [{ chatId: 'chat', messageId: 'message-1' }],
            revision: 4,
        }],
        appliedOperationIds: [],
    }
}

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('RisuBardNarrativeGraph', () => {
    test('renders an accessible graph and reveals selected node context', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardNarrativeGraph, {
            target,
            props: { graph: graph() },
        })

        expect(target.querySelectorAll('[data-memory-node-id]')).toHaveLength(3)
        expect(target.querySelectorAll('[data-memory-edge-id]')).toHaveLength(1)

        const belief = target.querySelector<HTMLButtonElement>(
            '[data-memory-node-id="claim:oath"]'
        )
        expect(belief).not.toBeNull()
        belief!.click()
        await tick()

        const detail = target.querySelector('[data-memory-node-detail]')
        expect(detail?.textContent).toContain('Hidden oath summary')
        expect(detail?.textContent).toContain('entity:lina')
        expect(detail?.textContent).toContain('believed_by')

        const search = target.querySelector<HTMLInputElement>(
            'input[type="search"]'
        )
        expect(search).not.toBeNull()
        search!.value = 'arrival'
        search!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(target.querySelectorAll('[data-memory-node-id]')).toHaveLength(1)
        expect(target.textContent).toContain('Arrival')
    })

    test('bounds selected evidence rendering', () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        const denseGraph = graph()
        denseGraph.nodes[0].evidence = Array.from(
            { length: 100 },
            (_, index) => ({
                chatId: 'chat',
                messageId: `message-${index}`,
            })
        )
        mounted = mount(RisuBardNarrativeGraph, {
            target,
            props: { graph: denseGraph },
        })

        const evidence = target.querySelector('[data-memory-node-evidence]')
        expect(evidence?.querySelectorAll('li')).toHaveLength(16)
        expect(evidence?.textContent).toContain('16 / 100')
    })

    test('switches to a bounded wiki index without loading another graph', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardNarrativeGraph, {
            target,
            props: { graph: graph() },
        })

        const wikiToggle = target.querySelector<HTMLButtonElement>(
            '[data-memory-view-toggle="wiki"]'
        )
        expect(wikiToggle).not.toBeNull()
        wikiToggle!.click()
        await tick()

        const index = target.querySelector('[data-memory-wiki-index]')
        expect(index).not.toBeNull()
        expect(index?.querySelectorAll('[data-memory-wiki-node]'))
            .toHaveLength(3)
        expect(target.querySelector('[data-memory-graph-viewport]')).toBeNull()

        const arrival = index?.querySelector<HTMLButtonElement>(
            '[data-memory-wiki-node="event:arrival"]'
        )
        arrival?.click()
        await tick()
        expect(target.querySelector('[data-memory-node-detail]')?.textContent)
            .toContain('Arrival summary')
    })

    test('centers and pointer-pans the graph viewport', async () => {
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardNarrativeGraph, {
            target,
            props: { graph: graph() },
        })
        const viewport = target.querySelector<HTMLElement>(
            '[data-memory-graph-viewport]'
        )
        expect(viewport).not.toBeNull()
        Object.defineProperties(viewport!, {
            scrollWidth: { configurable: true, value: 1_200 },
            clientWidth: { configurable: true, value: 600 },
            scrollHeight: { configurable: true, value: 900 },
            clientHeight: { configurable: true, value: 500 },
        })

        target.querySelector<HTMLButtonElement>(
            '[data-memory-graph-center]'
        )?.click()
        expect(viewport?.scrollLeft).toBe(300)
        expect(viewport?.scrollTop).toBe(200)

        viewport!.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            pointerId: 7,
            clientX: 100,
            clientY: 100,
        }))
        viewport!.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 7,
            clientX: 60,
            clientY: 70,
        }))
        expect(viewport?.scrollLeft).toBe(340)
        expect(viewport?.scrollTop).toBe(230)
    })
})
