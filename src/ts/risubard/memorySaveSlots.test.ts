import { describe, expect, test, vi } from 'vitest'
import type { Chat } from '../storage/database.svelte'
import {
    countChatTurns,
    createMemorySaveSlot,
    encodeMemorySaveChat,
    listMemorySaveSlots,
    prepareMemorySaveLoad,
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
    latestEvent: { title: '성문이 열렸다', excerpt: '경비병이 허락했다.' },
}

describe('memory save slot client', () => {
    test('counts only visible assistant story turns', () => {
        expect(countChatTurns(chat.message)).toBe(1)
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
        const encodedName = headers['x-risubard-chat-name']
            .replaceAll('-', '+').replaceAll('_', '/')
        expect(Buffer.from(encodedName, 'base64').toString('utf8')).toBe('성문 앞')
        expect(calls[0].init?.body).toBeInstanceOf(ArrayBuffer)
    })

    test('lists strict summaries and decodes a prepared chat load', async () => {
        const savedBytes = encodeMemorySaveChat(chat)
        const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
            if (String(url).endsWith('/list')) {
                return new Response(JSON.stringify([summary]))
            }
            return new Response(Uint8Array.from(savedBytes).buffer, {
                headers: {
                    'content-type': 'application/octet-stream',
                    'x-risubard-fork-token': 'load-token',
                },
            })
        }) as unknown as typeof fetch

        await expect(listMemorySaveSlots({
            characterId: 'character', fetchImpl,
            createAuth: async () => 'auth',
        })).resolves.toEqual([summary])
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
})
