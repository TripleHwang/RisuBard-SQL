// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import type { NarrativeGraphViewSnapshot } from 'src/ts/risubard/memoryGraphView'

const mocks = vi.hoisted(() => ({
    applyCharacterPromotion: vi.fn(),
    createCharacterPromotionPreview: vi.fn(),
    createPromoteCharacterCommand: vi.fn(),
    eligibleCharacterPromotionSources: vi.fn(),
    requestCharacterPromotionDraft: vi.fn(),
    requestChatData: vi.fn(),
    onApplied: vi.fn(),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    forageStorage: {
        createAuth: vi.fn(async () => 'auth-token'),
    },
}))
vi.mock('src/ts/process/request/request', () => ({
    requestChatData: mocks.requestChatData,
}))
vi.mock('src/ts/risubard/writerWorkbench', () => ({
    applyCharacterPromotion: mocks.applyCharacterPromotion,
    createCharacterPromotionPreview: mocks.createCharacterPromotionPreview,
    createPromoteCharacterCommand: mocks.createPromoteCharacterCommand,
    eligibleCharacterPromotionSources:
        mocks.eligibleCharacterPromotionSources,
    requestCharacterPromotionDraft: mocks.requestCharacterPromotionDraft,
}))

import RisuBardWriterWorkbench from './RisuBardWriterWorkbench.svelte'

let mounted: ReturnType<typeof mount> | undefined

function graph(nodeCount = 1): NarrativeGraphViewSnapshot {
    return {
        schemaVersion: 2,
        storyId: 'character',
        branchId: 'chat',
        revision: 3,
        nodes: Array.from({ length: nodeCount }, (_, index) => ({
            id: `event:${index}`,
            kind: 'event' as const,
            subtype: 'event' as const,
            title: `Market encounter ${index}`,
            summary: 'The protagonist met a blue-haired elf.',
            storyId: 'character',
            branchId: 'chat',
            status: 'active' as const,
            authority: 'draft' as const,
            salience: 5,
            perspective: { kind: 'omniscient' as const },
            epistemic: 'fact' as const,
            evidence: [{
                chatId: 'chat',
                messageId: `message-${index}`,
            }],
            revision: 3,
        })),
        edges: [],
    }
}

function setInput(selector: string, value: string) {
    const input = document.body.querySelector(selector) as HTMLInputElement
        | HTMLTextAreaElement
        | HTMLSelectElement
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
    vi.clearAllMocks()
})

describe('RisuBardWriterWorkbench', () => {
    test('previews and explicitly applies a direct character promotion', async () => {
        const state = graph()
        mocks.eligibleCharacterPromotionSources.mockReturnValue(state.nodes)
        const command = {
            schemaVersion: 1,
            type: 'promote-character',
            commandId: 'promotion-eliana',
            storyId: 'character',
            branchId: 'chat',
            sourceNodeId: 'event:0',
            name: 'Eliana',
            summary: 'Eliana is the blue-haired elf.',
            salience: 9,
        }
        mocks.createPromoteCharacterCommand.mockReturnValue(command)
        mocks.createCharacterPromotionPreview.mockReturnValue({
            command,
            graphDelta: { operations: [{}, {}, {}, {}] },
        })
        mocks.applyCharacterPromotion.mockResolvedValue({ revision: 4 })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWriterWorkbench, {
            target,
            props: {
                graph: state,
                characterId: 'character',
                chatId: 'chat',
                onApplied: mocks.onApplied,
            },
        })
        await tick()

        setInput('[data-writer-name]', 'Eliana')
        setInput(
            '[data-writer-summary]',
            'Eliana is the blue-haired elf.'
        )
        setInput('[data-writer-salience]', '9')
        await tick()
        ;(document.body.querySelector(
            '[data-writer-preview]'
        ) as HTMLButtonElement).click()
        await tick()

        expect(mocks.requestCharacterPromotionDraft).not.toHaveBeenCalled()
        expect(document.body.querySelector(
            '[data-writer-proposal]'
        )?.textContent).toContain('Market encounter 0')
        expect(document.body.querySelector(
            '[data-writer-proposal]'
        )?.textContent).toContain('Eliana')
        ;(document.body.querySelector(
            '[data-writer-apply]'
        ) as HTMLButtonElement).click()
        await vi.waitFor(() => {
            expect(mocks.applyCharacterPromotion).toHaveBeenCalledWith(
                expect.objectContaining({
                    expectedRevision: 3,
                    command,
                })
            )
            expect(mocks.onApplied).toHaveBeenCalledWith(4)
        })
    })

    test('uses an LLM only to fill editable draft fields', async () => {
        const state = graph()
        mocks.eligibleCharacterPromotionSources.mockReturnValue(state.nodes)
        mocks.requestCharacterPromotionDraft.mockResolvedValue({
            name: 'Eliana',
            summary: 'Eliana is the blue-haired elf.',
            salience: 9,
        })
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWriterWorkbench, {
            target,
            props: {
                graph: state,
                characterId: 'character',
                chatId: 'chat',
            },
        })
        await tick()

        setInput(
            '[data-writer-instruction]',
            'Promote her as Eliana.'
        )
        await tick()
        ;(document.body.querySelector(
            '[data-writer-draft]'
        ) as HTMLButtonElement).click()
        await vi.waitFor(() => {
            expect(mocks.requestCharacterPromotionDraft)
                .toHaveBeenCalledOnce()
        })
        await tick()

        expect((document.body.querySelector(
            '[data-writer-name]'
        ) as HTMLInputElement).value).toBe('Eliana')
        expect((document.body.querySelector(
            '[data-writer-summary]'
        ) as HTMLTextAreaElement).value).toContain('blue-haired elf')
        expect(document.body.querySelector(
            '[data-writer-proposal]'
        )).toBeNull()
    })

    test('bounds source options and disables apply before preview', async () => {
        const state = graph(120)
        mocks.eligibleCharacterPromotionSources.mockReturnValue(
            state.nodes.slice(0, 96)
        )
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWriterWorkbench, {
            target,
            props: {
                graph: state,
                characterId: 'character',
                chatId: 'chat',
            },
        })
        await tick()

        expect(document.body.querySelectorAll(
            '[data-writer-source] option'
        )).toHaveLength(96)
        expect((document.body.querySelector(
            '[data-writer-apply]'
        ) as HTMLButtonElement).disabled).toBe(true)
    })

    test('can collapse and reopen the writer controls from its heading', async () => {
        const state = graph()
        mocks.eligibleCharacterPromotionSources.mockReturnValue(state.nodes)
        const target = document.createElement('div')
        document.body.appendChild(target)
        mounted = mount(RisuBardWriterWorkbench, {
            target,
            props: {
                graph: state,
                characterId: 'character',
                chatId: 'chat',
            },
        })
        await tick()

        const toggle = document.body.querySelector(
            '[data-writer-toggle]'
        ) as HTMLButtonElement
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
        expect(document.body.querySelector('[data-writer-body]')).not.toBeNull()

        toggle.click()
        await tick()
        expect(toggle.getAttribute('aria-expanded')).toBe('false')
        expect(document.body.querySelector('[data-writer-body]')).toBeNull()

        toggle.click()
        await tick()
        expect(toggle.getAttribute('aria-expanded')).toBe('true')
        expect(document.body.querySelector('[data-writer-body]')).not.toBeNull()
    })
})
