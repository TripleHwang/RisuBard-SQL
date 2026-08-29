import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
    fetchWholeChatContent,
    streamChatContentBatches,
    type ChatContentEvent,
} from './chatContentClient'

const { createChatContentPage } = require('../../../server/node/chat-content-page.cjs')

/**
 * The chat-content transfer, driven rather than read.
 *
 * The second case here used to assert that `nodeStorage.ts` contained certain
 * identifiers. That could only ever prove the strings were present: it passed
 * unchanged through the release that migrated every chat empty, because nothing
 * about the paging behaviour was actually exercised. The paging loop now lives
 * in `chatContentClient.ts` and is shared with the SQL migration, so this drives
 * it against the server's own `createChatContentPage`.
 */

interface TestMessage { data: string }

function buildChat(messageCount: number) {
    return {
        id: 'chat-1',
        name: 'Chat',
        note: 'a chat field that exists only in the content copy',
        message: Array.from({ length: messageCount }, (_, index) => ({ data: `message-${index}` })),
    }
}

/** A transport that answers the paged route from `createChatContentPage`. */
function pagedTransport(chat: ReturnType<typeof buildChat>, requests: string[]) {
    return async (input: string, init?: RequestInit) => {
        requests.push(input)
        expect(new Headers(init?.headers).get('x-chat-id')).toBe(chat.id)
        const url = new URL(input, 'https://risu.invalid')
        if (!url.pathname.endsWith('/page')) return Response.json({ error: 'not found' }, { status: 404 })
        const page = createChatContentPage(
            chat,
            url.searchParams.get('offset'),
            url.searchParams.get('limit'),
        )
        return Response.json(page)
    }
}

const decodeJson: (bytes: Uint8Array) => unknown = (bytes) =>
    JSON.parse(new TextDecoder().decode(bytes))

const target = { chaId: 'character-1', chatIndex: 0, chatId: 'chat-1' }

describe('chunked chat hydration connections', () => {
    it('serves authenticated bounded pages with existing chat-id checks', () => {
        const server = readFileSync('server/node/server.cjs', 'utf8')
        expect(server).toContain("require('./chat-content-page.cjs')")
        expect(server).toContain("app.get('/api/chat-content/:chaId/:chatIndex/page'")
        expect(server).toContain('createChatContentPage(chat, req.query.offset, req.query.limit)')
        expect(server).toContain("Chat ID mismatch — index may have shifted")
    })

    it('assembles a whole history out of bounded pages, in order', async () => {
        const chat = buildChat(45)
        const requests: string[] = []
        const assembled = await fetchWholeChatContent<TestMessage, Record<string, unknown>>({
            request: pagedTransport(chat, requests),
            decode: decodeJson,
            target,
            pageSize: 10,
        })

        expect(requests).toHaveLength(5)
        expect(requests[0]).toContain('/api/chat-content/character-1/0/page?offset=0&limit=10')
        expect(requests[4]).toContain('offset=40')
        expect(assembled?.message.map((message) => message.data)).toEqual(
            chat.message.map((message) => message.data),
        )
        // The chat's own fields ride on the page envelope, which is the only
        // place they exist once `database.bin` has been stripped to stubs.
        expect(assembled?.note).toBe('a chat field that exists only in the content copy')
        expect(assembled?.message).toHaveLength(45)
    })

    it('reports the history length before the first message is consumed', async () => {
        const chat = buildChat(30)
        const events: ChatContentEvent<TestMessage, Record<string, unknown>>[] = []
        for await (const event of streamChatContentBatches<TestMessage, Record<string, unknown>>({
            request: pagedTransport(chat, []),
            decode: decodeJson,
            target,
            pageSize: 10,
        })) {
            events.push(event)
        }

        // Metadata first: a consumer writing messages into a store keyed by chat
        // has to be able to create the chat before the first message lands.
        expect(events[0].kind).toBe('metadata')
        expect(events[0]).toMatchObject({ total: 30 })
        const batches = events.filter((event) => event.kind === 'batch')
        expect(batches).toHaveLength(3)
        expect(events.at(-1)).toMatchObject({ kind: 'end', outcome: { status: 'present', total: 30 } })
    })

    it('falls back to the unpaged endpoint, and reads its 404 as "no content"', async () => {
        const chat = buildChat(3)
        const requests: string[] = []
        const unpagedOnly = async (input: string) => {
            requests.push(input)
            if (input.endsWith('/page') || input.includes('/page?')) {
                return Response.json({ error: 'no such route' }, { status: 404 })
            }
            return Response.json(chat)
        }
        const assembled = await fetchWholeChatContent<TestMessage, Record<string, unknown>>({
            request: unpagedOnly,
            decode: decodeJson,
            target,
        })
        expect(requests).toEqual([
            '/api/chat-content/character-1/0/page?offset=0&limit=200',
            '/api/chat-content/character-1/0',
        ])
        expect(assembled?.message).toHaveLength(3)

        const missing = await fetchWholeChatContent<TestMessage, Record<string, unknown>>({
            request: async () => Response.json({ error: 'not found' }, { status: 404 }),
            decode: decodeJson,
            target,
        })
        expect(missing).toBeNull()
    })

    it('throws rather than returning a short history when a page fails', async () => {
        const chat = buildChat(45)
        const failAfterFirstPage = async (input: string, init?: RequestInit) => {
            const url = new URL(input, 'https://risu.invalid')
            if (url.searchParams.get('offset') !== '0') {
                return Response.json({ error: 'gateway' }, { status: 502 })
            }
            return pagedTransport(chat, [])(input, init)
        }
        await expect(
            fetchWholeChatContent<TestMessage, Record<string, unknown>>({
                request: failAfterFirstPage,
                decode: decodeJson,
                target,
                pageSize: 10,
            }),
        ).rejects.toThrow(/502/)
    })

    it('refuses pages that skip part of the history', async () => {
        const chat = buildChat(45)
        const skipsAPage = async (input: string, init?: RequestInit) => {
            const url = new URL(input, 'https://risu.invalid')
            const offset = Number(url.searchParams.get('offset'))
            // The server answers a request for offset 10 with page 20: the run
            // would still "finish", four messages short, if nothing checked.
            const shifted = offset === 0 ? input : input.replace(`offset=${offset}`, `offset=${offset + 10}`)
            return pagedTransport(chat, [])(shifted, init)
        }
        await expect(
            fetchWholeChatContent<TestMessage, Record<string, unknown>>({
                request: skipsAPage,
                decode: decodeJson,
                target,
                pageSize: 10,
            }),
        ).rejects.toThrow(/contiguous/)
    })
})
