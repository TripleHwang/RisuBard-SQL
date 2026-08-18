import { createRequire } from 'node:module'
import { describe, expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)

type Handler = (
    req: { body?: unknown; headers?: Record<string, string> },
    res: {
        status(code: number): unknown
        send(body: unknown): unknown
        setHeader(name: string, value: string): unknown
    },
    next: (error?: unknown) => void
) => unknown

function createHarness() {
    const routes = new Map<string, Handler>()
    const app = {
        post(path: string, handler: Handler) {
            routes.set(path, handler)
        },
    }
    const response = {
        statusCode: 200,
        body: undefined as unknown,
        headers: {} as Record<string, string>,
        status(code: number) {
            this.statusCode = code
            return this
        },
        send(body: unknown) {
            this.body = body
            return this
        },
        setHeader(name: string, value: string) {
            this.headers[name.toLowerCase()] = value
            return this
        },
    }
    return { app, routes, response }
}

describe('RisuBard memory routes', () => {
    test('passes a bounded wiki-wide literal replacement to persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            replaceWikiText: vi.fn(async () => ({ matches: 4, documents: 2 })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character', chatId: 'chat',
            find: '길버드', replacement: '길버트',
        }

        await harness.routes.get('/api/risubard/memory/wiki/replace')!(
            { body }, harness.response, vi.fn()
        )

        expect(service.replaceWikiText).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual({ matches: 4, documents: 2 })

        harness.response.statusCode = 200
        await harness.routes.get('/api/risubard/memory/wiki/replace')!(
            { body: { ...body, find: '' } }, harness.response, vi.fn()
        )
        expect(harness.response.statusCode).toBe(400)
    })

    test('validates binary save creation and save list requests', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const summary = {
            saveId: 'save-1', sourceChatId: 'chat-1', sourceChatName: '모험',
            createdAt: '2026-08-14T08:00:00.000Z', turnCount: 7,
        }
        const service = {
            createMemorySave: vi.fn(async () => summary),
            listMemorySaves: vi.fn(async () => [summary]),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })

        await harness.routes.get('/api/risubard/memory/save-slot')!({
            headers: {
                'x-risubard-character-id': 'character',
                'x-risubard-source-chat-id': 'chat-1',
                'x-risubard-save-id': 'save-1',
                'x-risubard-chat-name': Buffer.from('모험').toString('base64url'),
                'x-risubard-turn-count': '7',
            },
            body: Buffer.from([1, 2, 3]),
        }, harness.response, vi.fn())
        expect(service.createMemorySave).toHaveBeenCalledWith({
            characterId: 'character', sourceChatId: 'chat-1',
            saveId: 'save-1', sourceChatName: '모험', turnCount: 7,
            chatBytes: Buffer.from([1, 2, 3]),
        })
        expect(harness.response.body).toEqual(summary)

        await harness.routes.get('/api/risubard/memory/save-slot/list')!({
            body: { characterId: 'character' },
        }, harness.response, vi.fn())
        expect(service.listMemorySaves).toHaveBeenCalledWith({
            characterId: 'character',
        })
        expect(harness.response.body).toEqual([summary])
    })

    test('prepares a binary save load with a fork completion token', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            prepareMemorySaveLoad: vi.fn(async () => ({
                chatBytes: Buffer.from([4, 5, 6]),
                save: {
                    saveId: 'save-1', sourceChatId: 'chat-1',
                    sourceChatName: '모험', createdAt: 'now', turnCount: 7,
                },
                fork: {
                    forkToken: 'load-token', destinationChatId: 'chat-loaded',
                    mode: 'copy', sourceExists: true, warnings: [],
                },
            })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })

        await harness.routes.get('/api/risubard/memory/save-slot/load')!({
            body: {
                characterId: 'character', saveId: 'save-1',
                destinationChatId: 'chat-loaded',
            },
        }, harness.response, vi.fn())

        expect(service.prepareMemorySaveLoad).toHaveBeenCalledWith({
            characterId: 'character', saveId: 'save-1',
            destinationChatId: 'chat-loaded',
        })
        expect(harness.response.headers['x-risubard-fork-token'])
            .toBe('load-token')
        expect(harness.response.body).toEqual(Buffer.from([4, 5, 6]))
    })

    test('validates save preview, rename, and delete requests', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const renamed = {
            saveId: 'save-1', sourceChatId: 'chat-1',
            sourceChatName: '새 이름', createdAt: '2026-08-14T08:00:00.000Z',
            turnCount: 3,
        }
        const service = {
            previewMemorySave: vi.fn(async () => Buffer.from([7, 8])),
            renameMemorySave: vi.fn(async () => renamed),
            deleteMemorySave: vi.fn(async () => undefined),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const identity = { characterId: 'character', saveId: 'save-1' }

        await harness.routes.get('/api/risubard/memory/save-slot/preview')!({
            body: identity,
        }, harness.response, vi.fn())
        expect(service.previewMemorySave).toHaveBeenCalledWith(identity)
        expect(harness.response.headers['content-type'])
            .toBe('application/octet-stream')
        expect(harness.response.body).toEqual(Buffer.from([7, 8]))

        await harness.routes.get('/api/risubard/memory/save-slot/rename')!({
            body: { ...identity, name: '새 이름' },
        }, harness.response, vi.fn())
        expect(service.renameMemorySave).toHaveBeenCalledWith({
            ...identity, name: '새 이름',
        })
        expect(harness.response.body).toEqual(renamed)

        await harness.routes.get('/api/risubard/memory/save-slot/delete')!({
            body: identity,
        }, harness.response, vi.fn())
        expect(service.deleteMemorySave).toHaveBeenCalledWith(identity)
        expect(harness.response.statusCode).toBe(204)
    })

    test('authenticates and validates copy and branch memory forks', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            forkMemory: vi.fn(async (input) => ({
                mode: input.mode,
                sourceExists: true,
                destinationChatId: input.destinationChatId,
                warnings: [],
            })),
        }
        const auth = vi.fn(async () => true)
        registerRisuBardMemoryRoutes(harness.app, { auth, service })
        const route = harness.routes.get('/api/risubard/memory/fork')!

        await route({ body: {
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'copy', mode: 'copy',
        } }, harness.response, vi.fn())
        expect(auth).toHaveBeenCalledOnce()
        expect(service.forkMemory).toHaveBeenLastCalledWith({
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'copy', mode: 'copy',
        })
        expect(harness.response.body).toMatchObject({ mode: 'copy' })

        harness.response.statusCode = 200
        await route({ body: {
            characterId: 'source-character',
            destinationCharacterId: 'clone-character',
            sourceChatId: 'source', destinationChatId: 'copy-2', mode: 'copy',
        } }, harness.response, vi.fn())
        expect(service.forkMemory).toHaveBeenLastCalledWith({
            characterId: 'source-character',
            destinationCharacterId: 'clone-character',
            sourceChatId: 'source', destinationChatId: 'copy-2', mode: 'copy',
        })
        expect(harness.response.statusCode).toBe(200)

        harness.response.statusCode = 200
        await route({ body: {
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['user-1', 'assistant-1'],
            messageIds: [
                'user-1', 'assistant-1', 'user-2', 'assistant-2',
            ],
        } }, harness.response, vi.fn())
        expect(service.forkMemory).toHaveBeenLastCalledWith({
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['user-1', 'assistant-1'],
            messageIds: [
                'user-1', 'assistant-1', 'user-2', 'assistant-2',
            ],
        })

        for (const body of [
            {
                characterId: 'character', sourceChatId: 'same',
                destinationChatId: 'same', mode: 'copy',
            },
            {
                characterId: 'character', sourceChatId: 'source',
                destinationChatId: 'branch', mode: 'branch',
                messageIds: ['assistant-1'],
            },
            {
                characterId: 'character', sourceChatId: 'source',
                destinationChatId: 'copy', mode: 'copy',
                retainedMessageIds: [],
            },
        ]) {
            harness.response.statusCode = 200
            await route({ body }, harness.response, vi.fn())
            expect(harness.response.statusCode).toBe(400)
        }
    })

    test('does not send a fork success when the service fails', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const error = new Error('copy failed')
        const next = vi.fn()
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service: { forkMemory: vi.fn(async () => { throw error }) },
        })

        await harness.routes.get('/api/risubard/memory/fork')!({ body: {
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'copy', mode: 'copy',
        } }, harness.response, next)

        expect(next).toHaveBeenCalledWith(error)
        expect(harness.response.body).toBeUndefined()
    })

    test('authenticates and validates fork finalize and discard requests', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            completeMemoryFork: vi.fn(async (input) => ({
                action: input.action,
                completed: true,
            })),
        }
        const auth = vi.fn(async () => true)
        registerRisuBardMemoryRoutes(harness.app, { auth, service })
        const route = harness.routes.get('/api/risubard/memory/fork/complete')!

        await route({ body: {
            characterId: 'character', destinationChatId: 'copy',
            forkToken: 'fork-token', action: 'finalize',
        } }, harness.response, vi.fn())
        expect(auth).toHaveBeenCalledOnce()
        expect(service.completeMemoryFork).toHaveBeenCalledWith({
            characterId: 'character', destinationChatId: 'copy',
            forkToken: 'fork-token', action: 'finalize',
        })
        expect(harness.response.body).toEqual({
            action: 'finalize', completed: true,
        })

        for (const body of [
            {
                characterId: 'character', destinationChatId: 'copy',
                forkToken: '', action: 'discard',
            },
            {
                characterId: 'character', destinationChatId: 'copy',
                forkToken: 'fork-token', action: 'invalid',
            },
            {
                characterId: 'character', destinationChatId: 'copy',
                forkToken: 'fork-token', action: 'discard', extra: true,
            },
        ]) {
            harness.response.statusCode = 200
            await route({ body }, harness.response, vi.fn())
            expect(harness.response.statusCode).toBe(400)
        }
    })

    test('returns an explicit conflict for an invalid fork completion token', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service: {
                completeMemoryFork: vi.fn(async () => {
                    throw new Error('Memory fork token does not match')
                }),
            },
        })

        await harness.routes.get('/api/risubard/memory/fork/complete')!({
            body: {
                characterId: 'character', destinationChatId: 'copy',
                forkToken: 'wrong-token', action: 'discard',
            },
        }, harness.response, vi.fn())

        expect(harness.response.statusCode).toBe(409)
        expect(harness.response.body).toEqual({
            error: 'Memory fork token does not match',
        })
    })

    test('returns an explicit conflict receipt for an unsafe branch', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const next = vi.fn()
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service: {
                forkMemory: vi.fn(async () => {
                    throw new Error(
                        'Memory fork conflict: manual edit is mixed with future changes'
                    )
                }),
            },
        })

        await harness.routes.get('/api/risubard/memory/fork')!({ body: {
            characterId: 'character', sourceChatId: 'source',
            destinationChatId: 'branch', mode: 'branch',
            retainedMessageIds: ['assistant-1'],
            messageIds: ['assistant-1', 'assistant-2'],
        } }, harness.response, next)

        expect(harness.response.statusCode).toBe(409)
        expect(harness.response.body).toEqual({
            error: 'Memory fork conflict: manual edit is mixed with future changes',
        })
        expect(next).not.toHaveBeenCalled()
    })

    test('authenticates and bounds narrative inquiry requests', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            inquireNarrative: vi.fn(async () => ({
                mode: 'v2-current',
                sources: [],
            })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })

        await harness.routes.get('/api/risubard/memory/inquiry')!(
            {
                body: {
                    characterId: 'character',
                    chatId: 'chat',
                    currentInput: 'bridge',
                    tokenBudget: { target: 1_500, maximum: 4_500 },
                },
            },
            harness.response,
            vi.fn()
        )

        expect(service.inquireNarrative).toHaveBeenCalledWith({
            characterId: 'character',
            chatId: 'chat',
            currentInput: 'bridge',
            tokenBudget: { target: 1_500, maximum: 4_500 },
        })
        expect(harness.response.statusCode).toBe(200)

        await harness.routes.get('/api/risubard/memory/inquiry')!(
            {
                body: {
                    characterId: 'project',
                    chatId: 'chat',
                    currentInput: 'bridge',
                    consumer: 'editor',
                },
            },
            harness.response,
            vi.fn()
        )
        expect(harness.response.statusCode).toBe(400)

        await harness.routes.get('/api/risubard/memory/inquiry')!(
            {
                body: {
                    characterId: 'character', chatId: 'chat',
                    currentInput: 'bridge',
                    tokenBudget: { target: 6_000, maximum: 2_000 },
                },
            },
            harness.response,
            vi.fn()
        )
        expect(harness.response.statusCode).toBe(400)

        await harness.routes.get('/api/risubard/memory/inquiry')!(
            {
                body: {
                    characterId: 'character',
                    chatId: 'chat',
                    currentInput: 'x'.repeat(4_097),
                },
            },
            harness.response,
            vi.fn()
        )
        expect(harness.response.statusCode).toBe(400)
    })

    test('records only a strict scoped analysis observation', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            recordGraphAnalysis: vi.fn(),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const route = harness.routes.get(
            '/api/risubard/memory/analysis/observe'
        )!
        await route({
            body: {
                characterId: 'character',
                chatId: 'chat',
                status: 'failed',
                appliedCount: 0,
            },
        }, harness.response, vi.fn())

        expect(service.recordGraphAnalysis).toHaveBeenCalledWith(
            'character',
            'chat',
            { status: 'failed', appliedCount: 0 }
        )
        expect(harness.response.body).toEqual({ ok: true })

        harness.response.statusCode = 200
        await route({
            body: {
                characterId: 'character',
                chatId: 'chat',
                status: 'failed',
                appliedCount: 0,
                prompt: 'must not be logged',
            },
        }, harness.response, vi.fn())
        expect(harness.response.statusCode).toBe(400)
        expect(service.recordGraphAnalysis).toHaveBeenCalledOnce()
    })

    test('rejects request bodies above the transport limit before routing', async () => {
        const express = require('express')
        const { createRisuBardMemoryJsonParser } = require(
            './risubard-memory-routes.cjs'
        )
        const app = express()
        app.use('/memory', createRisuBardMemoryJsonParser(express))
        app.post('/memory/apply', (_req: unknown, res: {
            send(body: unknown): void
        }) => res.send({ reached: true }))
        app.use((
            error: { type?: string },
            _req: unknown,
            res: { status(code: number): { send(body: unknown): void } },
            _next: (error?: unknown) => void
        ) => {
            res.status(error.type === 'entity.too.large' ? 413 : 500)
                .send({ error: error.type })
        })
        const server = app.listen(0)
        try {
            const address = server.address()
            if (!address || typeof address === 'string') {
                throw new Error('Test server did not bind a TCP port')
            }
            const response = await fetch(
                `http://127.0.0.1:${address.port}/memory/apply`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ value: 'x'.repeat(513 * 1_024) }),
                }
            )
            expect(response.status).toBe(413)
        }
        finally {
            await new Promise<void>((resolve, reject) => {
                server.close((error?: Error) => {
                    if (error) reject(error)
                    else resolve()
                })
            })
        }
    })

    test('authenticates and returns current state without exposing a path', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const auth = vi.fn(async () => true)
        const service = {
            loadState: vi.fn(async () => ({
                schemaVersion: 1,
                facts: [],
                events: [],
                appliedOperationIds: [],
            })),
            applyDelta: vi.fn(),
        }
        registerRisuBardMemoryRoutes(harness.app, { auth, service })

        await harness.routes.get('/api/risubard/memory/state')!(
            { body: { characterId: 'character', chatId: 'chat' } },
            harness.response,
            vi.fn()
        )

        expect(auth).toHaveBeenCalledOnce()
        expect(service.loadState).toHaveBeenCalledWith('character', 'chat')
        expect(harness.response.body).toEqual({
            schemaVersion: 1,
            facts: [],
            events: [],
            appliedOperationIds: [],
        })
        expect(JSON.stringify(harness.response.body)).not.toContain('path')
    })

    test('passes only bounded delta data to the strict persistence service', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            loadState: vi.fn(),
            applyDelta: vi.fn(async () => ({
                schemaVersion: 1,
                facts: [],
                events: [],
                appliedOperationIds: ['operation-1'],
            })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 1,
                operations: [{
                    type: 'append-event',
                    operationId: 'operation-1',
                    eventId: 'event-1',
                    summary: 'The door opened.',
                    evidence: [{
                        chatId: 'chat',
                        messageId: 'message-1',
                    }],
                }],
            },
            availableEvidence: [{
                chatId: 'chat',
                messageId: 'message-1',
            }],
        }

        await harness.routes.get('/api/risubard/memory/apply')!(
            { body },
            harness.response,
            vi.fn()
        )

        expect(service.applyDelta).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual({
            schemaVersion: 1,
            facts: [],
            events: [],
            appliedOperationIds: ['operation-1'],
        })
    })

    test('authenticates and passes bounded v2 graph deltas to graph persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const graph = {
            schemaVersion: 2,
            storyId: 'character',
            branchId: 'chat',
            revision: 1,
            nodes: [],
            edges: [],
            appliedOperationIds: [],
        }
        const service = {
            loadState: vi.fn(),
            applyDelta: vi.fn(),
            loadGraphState: vi.fn(async () => graph),
            applyGraphDelta: vi.fn(async () => graph),
            reconcileGraphV1: vi.fn(async () => graph),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            delta: {
                schemaVersion: 2,
                storyId: 'character',
                branchId: 'chat',
                operations: [],
            },
            availableEvidence: [],
        }

        await harness.routes.get('/api/risubard/memory/graph/apply')!(
            { body },
            harness.response,
            vi.fn()
        )
        expect(service.applyGraphDelta).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual({ revision: 1 })

        await harness.routes.get('/api/risubard/memory/graph/state')!(
            { body: { characterId: 'character', chatId: 'chat' } },
            harness.response,
            vi.fn()
        )
        expect(service.loadGraphState).toHaveBeenCalledWith(
            'character',
            'chat'
        )

        await harness.routes.get(
            '/api/risubard/memory/graph/reconcile'
        )!(
            { body: { characterId: 'character', chatId: 'chat' } },
            harness.response,
            vi.fn()
        )
        expect(service.reconcileGraphV1).toHaveBeenCalledWith(
            'character',
            'chat'
        )
        expect(harness.response.body).toEqual({ revision: 1 })
    })

    test('authenticates and passes one bounded writer command to persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            applyWriterCommand: vi.fn(async () => ({ revision: 4 })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 3,
            command: {
                schemaVersion: 1,
                type: 'promote-character',
                commandId: 'promotion-eliana',
                storyId: 'character',
                branchId: 'chat',
                sourceNodeId: 'event:v1:market-collision',
                name: 'Eliana',
                summary: 'Eliana is the blue-haired elf from the market.',
                salience: 9,
            },
        }

        await harness.routes.get('/api/risubard/memory/writer/apply')!(
            { body },
            harness.response,
            vi.fn()
        )

        expect(service.applyWriterCommand).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual({ revision: 4 })
        expect(JSON.stringify(harness.response.body)).not.toMatch(
            /operation|binding|path/i
        )
    })

    test('passes one explicit canonical Markdown approval to persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const document = {
            id: 'character.lavian',
            type: 'character',
            status: 'active',
            title: '라비안',
        }
        const service = {
            saveCanonicalWikiDocument: vi.fn(async () => document),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            type: 'character',
            title: '라비안',
            sourceMessageIds: ['user-1', 'assistant-1'],
            markdown: '# 라비안\n\n오른팔에 화상을 입었다.',
            reviewStatus: 'unreviewed',
        }

        await harness.routes.get(
            '/api/risubard/memory/wiki/document/save'
        )!({ body }, harness.response, vi.fn())

        expect(service.saveCanonicalWikiDocument).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual(document)
    })

    test('passes an AI-free Markdown save with no evidence messages', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const document = {
            id: 'faction.order',
            type: 'faction',
            status: 'active',
            title: '은촛대 수도회',
        }
        const service = {
            saveManualWikiDocument: vi.fn(async () => document),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            type: 'faction',
            title: '은촛대 수도회',
            markdown: '# 은촛대 수도회\n\n사용자 작성.',
        }

        await harness.routes.get(
            '/api/risubard/memory/wiki/document/manual-save'
        )!({ body }, harness.response, vi.fn())

        expect(service.saveManualWikiDocument).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual(document)
    })

    test('passes a bounded canonical context-mode change to persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const document = {
            id: 'character.lavian',
            type: 'character',
            status: 'active',
            contextMode: 'always',
        }
        const service = {
            setWikiDocumentContextMode: vi.fn(async () => document),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            documentId: 'character.lavian',
            contextMode: 'always',
            expectedContentHash: 'current-hash',
        }

        await harness.routes.get(
            '/api/risubard/memory/wiki/document/context-mode'
        )!({ body }, harness.response, vi.fn())

        expect(service.setWikiDocumentContextMode).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual(document)
    })

    test('passes an explicit canonical trash request to persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            trashWikiDocument: vi.fn(async () => ({
                id: 'character.lavian',
                trashed: true,
            })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            documentId: 'character.lavian',
        }

        await harness.routes.get(
            '/api/risubard/memory/wiki/document/trash'
        )!({ body }, harness.response, vi.fn())

        expect(service.trashWikiDocument).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual({
            id: 'character.lavian',
            trashed: true,
        })
    })

    test('passes a bounded event retraction request to persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const event = {
            id: 'event.turn-1',
            type: 'event',
            status: 'retracted',
            contentHash: 'hash-retracted',
        }
        const service = {
            retractWikiEvent: vi.fn(async () => event),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            documentId: 'event.turn-1',
            expectedContentHash: 'hash-active',
        }

        await harness.routes.get(
            '/api/risubard/memory/wiki/event/retract'
        )!({ body }, harness.response, vi.fn())

        expect(service.retractWikiEvent).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual(event)
    })

    test('passes confirmed message sources to event retraction', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            retractWikiEventsBySourceMessages: vi.fn(async () => ({
                retractedIds: ['event.turn-1'],
            })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['assistant-1'],
        }

        await harness.routes.get(
            '/api/risubard/memory/wiki/event/retract-sources'
        )!({ body }, harness.response, vi.fn())

        expect(service.retractWikiEventsBySourceMessages).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual({
            retractedIds: ['event.turn-1'],
        })
    })

    test('passes one bounded wiki file reveal request to the runtime', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            revealWikiDocument: vi.fn(async () => ({ ok: true })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character',
            chatId: 'chat',
            documentId: 'character.lavian',
        }

        await harness.routes.get(
            '/api/risubard/memory/wiki/document/reveal'
        )!({ body }, harness.response, vi.fn())

        expect(service.revealWikiDocument).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual({ ok: true })
    })

    test('passes a bounded pre-turn wiki snapshot request to the runtime', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            snapshotWikiBeforeTurn: vi.fn(async () => ({
                snapshotId: 'turn-stable', canonicalCount: 2,
            })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true, service,
        })
        const body = {
            characterId: 'character', chatId: 'chat',
            sourceMessageIds: ['user-1', 'assistant-1'],
        }

        await harness.routes.get('/api/risubard/memory/wiki/snapshot')!(
            { body }, harness.response, vi.fn()
        )

        expect(service.snapshotWikiBeforeTurn).toHaveBeenCalledWith(body)
        expect(harness.response.body).toEqual({
            snapshotId: 'turn-stable', canonicalCount: 2,
        })
    })

    test('passes turn receipt recording and undo requests to the runtime', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const receipt = {
            snapshotId: 'turn-stable', sourceMessageIds: ['assistant-1'],
            eventIds: [], changes: [], warnings: [], recordedAt: 'now',
        }
        const service = {
            recordWikiTurnReceipt: vi.fn(async () => receipt),
            undoWikiTurnReceipt: vi.fn(async () => ({
                ...receipt, undoneAt: 'later',
            })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true, service,
        })
        const record = {
            characterId: 'character', chatId: 'chat',
            snapshotId: 'turn-stable', sourceMessageIds: ['assistant-1'],
            eventId: 'event.stable', changes: [{
                documentId: 'location.ruins', type: 'location', title: '폐촌',
                relativePath: 'locations/ruins.md', afterHash: 'hash-after',
            }], warnings: ['낮은 확신'],
        }
        await harness.routes.get('/api/risubard/memory/wiki/receipt')!(
            { body: record }, harness.response, vi.fn()
        )
        expect(service.recordWikiTurnReceipt).toHaveBeenCalledWith(record)

        const undo = {
            characterId: 'character', chatId: 'chat',
            snapshotId: 'turn-stable', documentId: 'location.ruins',
        }
        await harness.routes.get('/api/risubard/memory/wiki/receipt/undo')!(
            { body: undo }, harness.response, vi.fn()
        )
        expect(service.undoWikiTurnReceipt).toHaveBeenCalledWith(undo)
        expect(harness.response.body).toMatchObject({ undoneAt: 'later' })
    })

    test.each([
        {
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: -1,
            command: {},
        },
        {
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 0,
            command: {},
            path: '../escape',
        },
        {
            characterId: 'character',
            chatId: 'chat',
            expectedRevision: 0,
            command: { content: 'x'.repeat(65_536) },
        },
    ])('rejects invalid writer command envelopes before persistence', async (body) => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            applyWriterCommand: vi.fn(),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })

        await harness.routes.get('/api/risubard/memory/writer/apply')!(
            { body },
            harness.response,
            vi.fn()
        )

        expect(harness.response.statusCode).toBe(400)
        expect(service.applyWriterCommand).not.toHaveBeenCalled()
    })

    test('returns a stable conflict response for stale writer revisions', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            applyWriterCommand: vi.fn(async () => {
                throw new Error('Writer graph revision is stale')
            }),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })

        await harness.routes.get('/api/risubard/memory/writer/apply')!(
            {
                body: {
                    characterId: 'character',
                    chatId: 'chat',
                    expectedRevision: 0,
                    command: {},
                },
            },
            harness.response,
            vi.fn()
        )

        expect(harness.response.statusCode).toBe(409)
        expect(harness.response.body).toEqual({
            error: 'Writer graph revision is stale',
        })
    })

    test('rejects oversized v2 graph operation arrays before persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            loadState: vi.fn(),
            applyDelta: vi.fn(),
            applyGraphDelta: vi.fn(),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })

        await harness.routes.get('/api/risubard/memory/graph/apply')!(
            {
                body: {
                    characterId: 'character',
                    chatId: 'chat',
                    delta: {
                        schemaVersion: 2,
                        storyId: 'character',
                        branchId: 'chat',
                        operations: Array.from(
                            { length: 129 },
                            (_, index) => ({ operationId: `op-${index}` })
                        ),
                    },
                    availableEvidence: [],
                },
            },
            harness.response,
            vi.fn()
        )
        expect(harness.response.statusCode).toBe(400)
        expect(service.applyGraphDelta).not.toHaveBeenCalled()
    })

    test('rejects extra fields and oversized operation arrays before persistence', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            loadState: vi.fn(),
            applyDelta: vi.fn(),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const apply = harness.routes.get('/api/risubard/memory/apply')!

        await apply(
            {
                body: {
                    characterId: 'character',
                    chatId: 'chat',
                    delta: { schemaVersion: 1, operations: [] },
                    availableEvidence: [],
                    path: '../escape',
                },
            },
            harness.response,
            vi.fn()
        )
        expect(harness.response.statusCode).toBe(400)

        harness.response.statusCode = 200
        await apply(
            {
                body: {
                    characterId: 'character',
                    chatId: 'chat',
                    delta: {
                        schemaVersion: 1,
                        operations: Array.from(
                            { length: 129 },
                            (_, index) => ({ operationId: `op-${index}` })
                        ),
                    },
                    availableEvidence: [],
                },
            },
            harness.response,
            vi.fn()
        )
        expect(harness.response.statusCode).toBe(400)
        expect(service.applyDelta).not.toHaveBeenCalled()
    })

    test('does nothing when authentication fails', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            loadState: vi.fn(),
            applyDelta: vi.fn(),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => false,
            service,
        })

        await harness.routes.get('/api/risubard/memory/state')!(
            { body: { characterId: 'character', chatId: 'chat' } },
            harness.response,
            vi.fn()
        )

        expect(service.loadState).not.toHaveBeenCalled()
    })

    test('authenticates and persists only a strict source snapshot', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const snapshot = {
            schemaVersion: 1,
            sources: [{
                sourceId: 'character-description:character',
                kind: 'character-description',
                content: 'Description',
                fingerprint: 'fingerprint',
            }],
        }
        const service = {
            loadState: vi.fn(),
            applyDelta: vi.fn(),
            ensureSourceSnapshot: vi.fn(async () => ({
                snapshot,
                baseline: null,
            })),
            saveSourceBaseline: vi.fn(),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })

        await harness.routes.get('/api/risubard/memory/source')!(
            { body: { characterId: 'character', chatId: 'chat', snapshot } },
            harness.response,
            vi.fn()
        )

        expect(service.ensureSourceSnapshot).toHaveBeenCalledWith(
            'character',
            'chat',
            snapshot
        )
        expect(harness.response.body).toEqual({
            snapshot,
            baseline: null,
        })
    })

    test('returns the read-only memory wiki view for one chat', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const view = {
            mode: 'v1',
            reason: 'missing-or-stale-v2-index',
            baseline: 'Current situation',
            state: {
                facts: [],
                events: [],
            },
        }
        const service = {
            loadState: vi.fn(),
            applyDelta: vi.fn(),
            loadView: vi.fn(async () => view),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })

        await harness.routes.get('/api/risubard/memory/view')!(
            { body: { characterId: 'character', chatId: 'chat' } },
            harness.response,
            vi.fn()
        )

        expect(service.loadView).toHaveBeenCalledWith('character', 'chat')
        expect(harness.response.body).toEqual(view)
        expect(JSON.stringify(harness.response.body)).not.toContain('path')
    })

    test('authenticates strict canonical review actions', async () => {
        const { registerRisuBardMemoryRoutes } = require(
            './risubard-memory-routes.cjs'
        )
        const harness = createHarness()
        const service = {
            reviewCanonicalWikiDocument: vi.fn(async (input) => ({
                id: input.documentId,
                reviewStatus: 'reviewed',
            })),
        }
        registerRisuBardMemoryRoutes(harness.app, {
            auth: async () => true,
            service,
        })
        const body = {
            characterId: 'character', chatId: 'chat',
            documentId: 'character.lavian', action: 'revert',
            expectedContentHash: 'hash-current',
        }
        await harness.routes.get('/api/risubard/memory/wiki/document/review')!(
            { body }, harness.response, vi.fn()
        )
        expect(service.reviewCanonicalWikiDocument).toHaveBeenCalledWith(body)

        harness.response.statusCode = 200
        await harness.routes.get('/api/risubard/memory/wiki/document/review')!(
            { body: { ...body, action: 'delete' } },
            harness.response,
            vi.fn()
        )
        expect(harness.response.statusCode).toBe(400)
    })
})
