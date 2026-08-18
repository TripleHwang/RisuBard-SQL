import type { Chat, Message } from '../storage/database.svelte'
import { Packr, Unpackr } from 'msgpackr/index-no-eval'
import { invokeBrowserFetch } from './browserFetch'

const chatPacker = new Packr({ useRecords: false })
const chatUnpacker = new Unpackr({
    int64AsType: 'number',
    useRecords: false,
})

export interface MemorySaveEventPreview {
    title: string
    excerpt: string
}

export interface MemorySaveSlotSummary {
    saveId: string
    sourceChatId: string
    sourceChatName: string
    createdAt: string
    turnCount: number
    latestEvent?: MemorySaveEventPreview
}

export interface MemorySavePreviewMessage {
    role: 'user' | 'char'
    data: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedId(value: string, label: string): string {
    if (typeof value !== 'string'
        || value.trim().length === 0
        || value.length > 1_024) {
        throw new Error(`${label} must be a non-empty bounded ID`)
    }
    return value
}

function encodeBase64Url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64')
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '')
}

function parseEvent(value: unknown): MemorySaveEventPreview {
    if (!isRecord(value)
        || Object.keys(value).length !== 2
        || typeof value.title !== 'string'
        || value.title.trim().length === 0
        || value.title.length > 512
        || typeof value.excerpt !== 'string'
        || value.excerpt.length > 1_000) {
        throw new Error('Invalid memory save event preview')
    }
    return { title: value.title, excerpt: value.excerpt }
}

function parseSummary(value: unknown): MemorySaveSlotSummary {
    if (!isRecord(value)) throw new Error('Invalid memory save summary')
    const hasEvent = value.latestEvent !== undefined
    const keys = [
        'saveId', 'sourceChatId', 'sourceChatName', 'createdAt', 'turnCount',
        ...(hasEvent ? ['latestEvent'] : []),
    ]
    if (Object.keys(value).length !== keys.length
        || !keys.every((key) => Object.hasOwn(value, key))
        || typeof value.saveId !== 'string'
        || typeof value.sourceChatId !== 'string'
        || typeof value.sourceChatName !== 'string'
        || value.sourceChatName.length > 512
        || typeof value.createdAt !== 'string'
        || !Number.isFinite(Date.parse(value.createdAt))
        || !Number.isSafeInteger(value.turnCount)
        || (value.turnCount as number) < 0) {
        throw new Error('Invalid memory save summary')
    }
    return {
        saveId: boundedId(value.saveId, 'Saved slot ID'),
        sourceChatId: boundedId(value.sourceChatId, 'Saved source chat ID'),
        sourceChatName: value.sourceChatName,
        createdAt: value.createdAt,
        turnCount: value.turnCount as number,
        ...(hasEvent ? { latestEvent: parseEvent(value.latestEvent) } : {}),
    }
}

async function failureDetail(response: Response): Promise<string> {
    const value: unknown = await response.json().catch(() => undefined)
    return isRecord(value)
        && typeof value.error === 'string'
        && value.error.length <= 1_000
        ? `: ${value.error}`
        : ''
}

export function countChatTurns(messages: readonly Message[]): number {
    return messages.filter((message) =>
        message.role === 'char'
        && !message.isComment
        && !message.disabled
    ).length
}

export function encodeMemorySaveChat(chat: Chat): Uint8Array {
    return chatPacker.pack(chat)
}

export function decodeMemorySaveChat(bytes: Uint8Array): unknown {
    return chatUnpacker.unpack(bytes)
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
    return Uint8Array.from(bytes).buffer
}

export async function createMemorySaveSlot(input: {
    characterId: string
    chat: Chat
    saveId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySaveSlotSummary> {
    const characterId = boundedId(input.characterId, 'Character ID')
    const sourceChatId = boundedId(input.chat.id ?? '', 'Chat ID')
    const saveId = boundedId(input.saveId, 'Save slot ID')
    if (typeof input.chat.name !== 'string'
        || input.chat.name.trim().length === 0
        || input.chat.name.length > 512) {
        throw new Error('Chat name must be a non-empty bounded string')
    }
    const snapshot = structuredClone(input.chat)
    delete snapshot._placeholder
    snapshot.isStreaming = false
    delete snapshot.activeStreamingDisplayOptimizationMode
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/octet-stream',
                'risu-auth': await input.createAuth(),
                'x-risubard-character-id': characterId,
                'x-risubard-source-chat-id': sourceChatId,
                'x-risubard-save-id': saveId,
                'x-risubard-chat-name': encodeBase64Url(snapshot.name),
                'x-risubard-turn-count': String(
                    countChatTurns(snapshot.message)
                ),
            },
            body: requestBody(encodeMemorySaveChat(snapshot)),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    return parseSummary(await response.json())
}

export async function listMemorySaveSlots(input: {
    characterId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySaveSlotSummary[]> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/list',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save list failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    const value: unknown = await response.json()
    if (!Array.isArray(value) || value.length > 10_000) {
        throw new Error('Invalid memory save list')
    }
    return value.map(parseSummary)
}

export async function renameMemorySaveSlot(input: {
    characterId: string
    saveId: string
    name: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySaveSlotSummary> {
    const name = input.name.trim()
    if (!name || name.length > 512) {
        throw new Error('Saved file name must be a non-empty bounded string')
    }
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/rename',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                saveId: boundedId(input.saveId, 'Saved file ID'),
                name,
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save rename failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    return parseSummary(await response.json())
}

export async function deleteMemorySaveSlot(input: {
    characterId: string
    saveId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<void> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/delete',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                saveId: boundedId(input.saveId, 'Saved file ID'),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save deletion failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
}

export async function previewMemorySaveSlot(input: {
    characterId: string
    saveId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<MemorySavePreviewMessage[]> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/preview',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                saveId: boundedId(input.saveId, 'Saved file ID'),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save preview failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    const decoded = decodeMemorySaveChat(
        new Uint8Array(await response.arrayBuffer())
    )
    if (!isRecord(decoded) || !Array.isArray(decoded.message)) {
        throw new Error('Memory save preview returned an invalid chat snapshot')
    }
    const visibleMessages = decoded.message
        .filter((message): message is Record<string, unknown> =>
            isRecord(message)
            && (message.role === 'user' || message.role === 'char')
            && typeof message.data === 'string'
            && !message.isComment
            && !message.disabled
        )
    const latestByRole = new Map<'user' | 'char', {
        index: number
        role: 'user' | 'char'
        data: string
    }>()
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
        const message = visibleMessages[index]
        const role = message.role as 'user' | 'char'
        if (!latestByRole.has(role)) {
            latestByRole.set(role, { index, role, data: message.data as string })
        }
        if (latestByRole.size === 2) break
    }
    return [...latestByRole.values()]
        .sort((left, right) => left.index - right.index)
        .map(({ role, data }) => ({ role, data }))
}

export async function prepareMemorySaveLoad(input: {
    characterId: string
    saveId: string
    destinationChatId: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<{ chat: Chat; forkToken: string }> {
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/save-slot/load',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify({
                characterId: boundedId(input.characterId, 'Character ID'),
                saveId: boundedId(input.saveId, 'Save slot ID'),
                destinationChatId: boundedId(
                    input.destinationChatId, 'Destination chat ID'
                ),
            }),
        }
    )
    if (!response.ok) {
        throw new Error(
            `Memory save load failed with status ${response.status}`
            + await failureDetail(response)
        )
    }
    const forkToken = response.headers.get('x-risubard-fork-token')
    if (!forkToken || forkToken.length > 1_024) {
        throw new Error('Memory save load response is missing its fork token')
    }
    const decoded: unknown = decodeMemorySaveChat(
        new Uint8Array(await response.arrayBuffer())
    )
    if (!isRecord(decoded)
        || !Array.isArray(decoded.message)
        || typeof decoded.name !== 'string') {
        throw new Error('Memory save load returned an invalid chat snapshot')
    }
    const chat = decoded as unknown as Chat
    if (typeof chat.note !== 'string') chat.note = ''
    if (!Array.isArray(chat.localLore)) chat.localLore = []
    return { chat, forkToken }
}
