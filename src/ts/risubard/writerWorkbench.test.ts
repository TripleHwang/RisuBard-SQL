import { describe, expect, test, vi } from 'vitest'
import type { NarrativeGraphViewSnapshot } from './memoryGraphView'
import {
    applyCharacterPromotion,
    createCharacterPromotionPreview,
    createPromoteCharacterCommand,
    eligibleCharacterPromotionSources,
    requestCharacterPromotionDraft,
    type WriterModelCall,
    type WriterModelResponse,
} from './writerWorkbench'

function graph(): NarrativeGraphViewSnapshot {
    return {
        schemaVersion: 2,
        storyId: 'character',
        branchId: 'chat',
        revision: 3,
        nodes: [{
            id: 'event:v1:market-collision',
            kind: 'event',
            subtype: 'event',
            title: 'Market collision',
            summary: 'The protagonist collided with a blue-haired elf.',
            storyId: 'character',
            branchId: 'chat',
            status: 'active',
            authority: 'draft',
            salience: 5,
            perspective: { kind: 'omniscient' },
            epistemic: 'fact',
            evidence: [{
                chatId: 'chat',
                messageId: 'message-market',
            }],
            revision: 3,
        }],
        edges: [],
    }
}

const draft = {
    name: 'Eliana',
    summary: 'Eliana is the blue-haired elf from the market.',
    salience: 9,
}

describe('writer workbench client', () => {
    test('requests a bounded editable draft from the current main model', async () => {
        let submitted: WriterModelCall | undefined
        const requestModel = vi.fn(async (
            request: WriterModelCall,
            mode: 'model'
        ): Promise<WriterModelResponse> => {
            submitted = structuredClone(request)
            expect(mode).toBe('model')
            return {
                type: 'success',
                result: JSON.stringify(draft),
            }
        })
        const source = graph().nodes[0]
        const before = structuredClone(source)

        await expect(requestCharacterPromotionDraft({
            sourceNode: source,
            instruction: 'Name her Eliana and preserve the market identity.',
            requestModel,
        })).resolves.toEqual(draft)

        expect(source).toEqual(before)
        expect(submitted).toMatchObject({
            useStreaming: false,
            noMultiGen: true,
            tools: [],
            maxTokens: 512,
            temperature: 0,
            formated: [
                expect.objectContaining({ role: 'system' }),
                expect.objectContaining({ role: 'user' }),
            ],
        })
        expect(JSON.parse(submitted?.schema ?? '{}')).toMatchObject({
            additionalProperties: false,
            required: ['name', 'summary', 'salience'],
        })
        expect(submitted?.formated[1].content).not.toContain(
            'E:\\'
        )
    })

    test('normalizes common structured-output variations without granting extra fields', async () => {
        await expect(requestCharacterPromotionDraft({
            sourceNode: graph().nodes[0],
            instruction: 'Promote this character.',
            requestModel: async () => ({
                type: 'success',
                result: JSON.stringify({
                    name: ' Eliana ',
                    summary: ' The blue-haired elf from the market. ',
                    salience: '8/10',
                    operationId: 'model-must-not-control-this',
                    notes: 'Editable explanation only.',
                }),
            }),
        })).resolves.toEqual({
            name: 'Eliana',
            summary: 'The blue-haired elf from the market.',
            salience: 8,
        })
    })

    test.each([
        ['{"name":"","summary":"Summary","salience":9}'],
        ['{"name":"Eliana","summary":"Summary","salience":11}'],
        ['{"name":"Eliana","summary":"Summary","salience":"high"}'],
        ['{} {}'],
    ])('rejects malformed model draft %#', async (result) => {
        await expect(requestCharacterPromotionDraft({
            sourceNode: graph().nodes[0],
            instruction: 'Promote this character.',
            requestModel: async () => ({ type: 'success', result }),
        })).rejects.toThrow()
    })

    test('preserves a failed model reason without attempting storage', async () => {
        await expect(requestCharacterPromotionDraft({
            sourceNode: graph().nodes[0],
            instruction: 'Promote this character.',
            requestModel: async () => ({
                type: 'fail',
                result: 'Model unavailable.',
            }),
        })).rejects.toThrow('Writer draft model request failed: Model unavailable.')
    })

    test('creates a deterministic strict command and preview without a model call', () => {
        const state = graph()
        const first = createPromoteCharacterCommand({
            graph: state,
            sourceNodeId: 'event:v1:market-collision',
            draft,
        })
        const second = createPromoteCharacterCommand({
            graph: structuredClone(state),
            sourceNodeId: 'event:v1:market-collision',
            draft: structuredClone(draft),
        })

        expect(first).toEqual(second)
        expect(first.commandId).toMatch(/^promotion-[0-9a-f]{16}$/)
        expect(first).toMatchObject({
            schemaVersion: 1,
            type: 'promote-character',
            storyId: 'character',
            branchId: 'chat',
            sourceNodeId: 'event:v1:market-collision',
            name: 'Eliana',
        })
        expect(createCharacterPromotionPreview({
            graph: state,
            command: first,
        }).graphDelta.operations).toHaveLength(4)
    })

    test('caps eligible active event and claim sources at 96', () => {
        const state = graph()
        state.nodes = Array.from({ length: 120 }, (_, index) => ({
            ...structuredClone(state.nodes[0]),
            id: `event:${index}`,
            title: `Event ${index}`,
        }))

        expect(eligibleCharacterPromotionSources(state)).toHaveLength(96)
    })

    test('posts one authenticated command and accepts only a revision receipt', async () => {
        const command = createPromoteCharacterCommand({
            graph: graph(),
            sourceNodeId: 'event:v1:market-collision',
            draft,
        })
        const fetchImpl = vi.fn(async (
            input: RequestInfo | URL,
            init?: RequestInit
        ) => {
            expect(String(input)).toBe(
                '/api/risubard/memory/writer/apply'
            )
            expect(init?.headers).toMatchObject({ 'risu-auth': 'jwt' })
            expect(JSON.parse(String(init?.body))).toEqual({
                characterId: 'character',
                chatId: 'chat',
                expectedRevision: 3,
                command,
            })
            return new Response(JSON.stringify({ revision: 4 }))
        })

        await expect(applyCharacterPromotion({
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 3,
            command,
            fetchImpl,
            createAuth: async () => 'jwt',
        })).resolves.toEqual({ revision: 4 })
        expect(fetchImpl).toHaveBeenCalledOnce()
    })

    test('invokes browser fetch with the Window-compatible global receiver', async () => {
        const command = createPromoteCharacterCommand({
            graph: graph(),
            sourceNodeId: 'event:v1:market-collision',
            draft,
        })
        const fetchImpl = function (this: unknown) {
            if (this !== globalThis) {
                throw new TypeError(
                    "'fetch' called on an object that does not implement interface Window."
                )
            }
            return Promise.resolve(new Response(JSON.stringify({
                revision: 4,
            })))
        } as typeof fetch

        await expect(applyCharacterPromotion({
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 3,
            command,
            fetchImpl,
            createAuth: async () => 'jwt',
        })).resolves.toEqual({ revision: 4 })
    })

    test('rejects stale and malformed writer receipts', async () => {
        const input = {
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 3,
            command: createPromoteCharacterCommand({
                graph: graph(),
                sourceNodeId: 'event:v1:market-collision',
                draft,
            }),
            createAuth: async () => 'jwt',
        }
        await expect(applyCharacterPromotion({
            ...input,
            fetchImpl: async () => new Response(
                JSON.stringify({ error: 'stale' }),
                { status: 409 }
            ),
        })).rejects.toThrow('Writer memory is stale')
        await expect(applyCharacterPromotion({
            ...input,
            fetchImpl: async () => new Response(JSON.stringify({
                revision: 4,
                operationId: 'leak',
            })),
        })).rejects.toThrow('Invalid writer promotion receipt')
    })
})
