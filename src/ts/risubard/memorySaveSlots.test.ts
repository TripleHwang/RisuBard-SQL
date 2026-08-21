import { describe, expect, test, vi } from 'vitest'
import type { Chat } from '../storage/database.svelte'
import {
    countChatTurns,
    createMemorySaveSlot,
    encodeMemorySaveChat,
    listMemorySaveSlots,
    deleteMemorySaveSlot,
    previewMemorySaveSlot,
    prepareMemorySaveLoad,
    renameMemorySaveSlot,
    latestChatMessageId,
    shouldConfirmMemorySaveLoad,
} from './memorySaveSlots'

const chat: Chat = {
    id: 'chat-1', name: '성문 앞', note: '', localLore: [],
    scriptstate: { '$trust': 3 },
    message: [
        { role: 'user', data: '들어간다.', chatId: 'user-1' },
        { role: 'char', data: '문이 열렸다.', chatId: 'assistant-1' },
        {
            role: 'char', data: '분기 표시', chatId: 'comment-1',
            isComment: true,
        },
        {
            role: 'char', data: '비활성 응답', chatId: 'disabled-1',
            disabled: true,
        },
    ],
}

const summary = {
    saveId: 'save-1', sourceChatId: 'chat-1', sourceChatName: '성문 앞',
    createdAt: '2026-08-14T08:00:00.000Z', turnCount: 1,
    latestMessageId: 'assistant-1',
    latestEvent: { title: '성문이 열렸다', excerpt: '경비병이 허락했다.' },
}

describe('memory save slot client', () => {
    test('counts only visible assistant story turns', () => {
        expect(countChatTurns(chat.message)).toBe(1)
        expect(latestChatMessageId(chat.message)).toBe('assistant-1')
        expect(latestChatMessageId([
            ...chat.message,
            { role: 'user', data: '아직 ID가 없는 최신 메시지' },
        ])).toBeUndefined()
    })

    test('asks before load unless the current story matches the newest save', () => {
        expect(shouldConfirmMemorySaveLoad('assistant-1', [summary])).toBe(false)
        expect(shouldConfirmMemorySaveLoad('unsaved-message', [summary])).toBe(true)
        expect(shouldConfirmMemorySaveLoad('assistant-1', [{
            ...summary,
            latestMessageId: undefined,
        }])).toBe(true)
    })

    test('sends a binary full-chat snapshot with bounded metadata headers', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
            calls.push({ url: String(url), init })
            return new Response(JSON.stringify(summary), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        }) as unknown as typeof fetch

        await expect(createMemorySaveSlot({
            characterId: 'character', chat,
            saveId: 'save-1', fetchImpl, createAuth: async () => 'auth',
        })).resolves.toEqual(summary)
        expect(calls[0].url).toBe('/api/risubard/memory/save-slot')
        const headers = calls[0].init?.headers as Record<string, string>
        expect(headers['x-risubard-turn-count']).toBe('1')
        expect(headers['x-risubard-latest-message-id']).toBe('assistant-1')
        const encodedName = headers['x-risubard-chat-name']
            .replaceAll('-', '+').replaceAll('_', '/')
        expect(Buffer.from(encodedName, 'base64').toString('utf8')).toBe('성문 앞')
        expect(calls[0].init?.body).toBeInstanceOf(ArrayBuffer)
    })

    test('lists strict summaries and decodes a prepared chat load', async () => {
        const savedBytes = encodeMemorySaveChat(chat)
        const fetchMock = vi.fn(async (
            url: URL | RequestInfo,
            _init?: RequestInit
        ) => {
            if (String(url).endsWith('/list')) {
                return new Response(JSON.stringify([summary]))
            }
            return new Response(Uint8Array.from(savedBytes).buffer, {
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-risubard-fork-token': 'load-token',
                },
            })
        })
        const fetchImpl = fetchMock as unknown as typeof fetch

        await expect(listMemorySaveSlots({
            characterId: 'character', sourceChatId: 'chat-1', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toEqual([summary])
        expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
            characterId: 'character', sourceChatId: 'chat-1',
        })
        const loaded = await prepareMemorySaveLoad({
            characterId: 'character', saveId: 'save-1',
            destinationChatId: 'loaded-chat', fetchImpl,
            createAuth: async () => 'auth',
        })
        expect(loaded).toMatchObject({
            forkToken: 'load-token',
            chat: {
                id: 'chat-1', name: '성문 앞',
                scriptstate: { '$trust': 3 },
            },
        })
        expect(loaded.chat.message.map((message) => message.chatId)).toEqual([
            'user-1', 'assistant-1', 'comment-1', 'disabled-1',
        ])
    })

    test('rejects a prepared load without its fork token', async () => {
        const fetchImpl = vi.fn(async () => new Response(
            Uint8Array.from(encodeMemorySaveChat(chat)).buffer,
            { headers: { 'content-type': 'application/octet-stream' } }
        )) as unknown as typeof fetch

        await expect(prepareMemorySaveLoad({
            characterId: 'character', saveId: 'save-1',
            destinationChatId: 'loaded-chat', fetchImpl,
            createAuth: async () => 'auth',
        })).rejects.toThrow('fork token')
    })

    test('renames and deletes a saved file through bounded JSON requests', async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = []
        const renamed = { ...summary, sourceChatName: '성 안뜰' }
        const fetchImpl = vi.fn(async (url: URL | RequestInfo, init?: RequestInit) => {
            calls.push({ url: String(url), init })
            return String(url).endsWith('/rename')
                ? new Response(JSON.stringify(renamed))
                : new Response(null, { status: 204 })
        }) as unknown as typeof fetch

        await expect(renameMemorySaveSlot({
            characterId: 'character', saveId: 'save-1', name: '성 안뜰',
            fetchImpl, createAuth: async () => 'auth',
        })).resolves.toEqual(renamed)
        await expect(deleteMemorySaveSlot({
            characterId: 'character', saveId: 'save-1', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toBeUndefined()
        expect(calls.map((call) => call.url)).toEqual([
            '/api/risubard/memory/save-slot/rename',
            '/api/risubard/memory/save-slot/delete',
        ])
        expect(JSON.parse(String(calls[0].init?.body))).toEqual({
            characterId: 'character', saveId: 'save-1', name: '성 안뜰',
        })
    })

    test('loads only the selected saved chat for a compact latest-message preview', async () => {
        const previewChat: Chat = {
            ...chat,
            message: [
                { role: 'user', data: '예전 질문', chatId: 'old-user' },
                { role: 'char', data: '예전 답변', chatId: 'old-char' },
                { role: 'user', data: '최신 질문', chatId: 'latest-user' },
                { role: 'char', data: '최신 답변', chatId: 'latest-char' },
                { role: 'char', data: '숨겨진 최신 답변', chatId: 'hidden-char', disabled: true },
            ],
        }
        const savedBytes = encodeMemorySaveChat(previewChat)
        const fetchImpl = vi.fn(async () => new Response(
            Uint8Array.from(savedBytes).buffer,
            { headers: { 'content-type': 'application/octet-stream' } }
        )) as unknown as typeof fetch

        await expect(previewMemorySaveSlot({
            characterId: 'character', saveId: 'save-1', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toEqual([
            { role: 'user', data: '최신 질문' },
            { role: 'char', data: '최신 답변' },
        ])
        expect(fetchImpl).toHaveBeenCalledOnce()
    })
})
