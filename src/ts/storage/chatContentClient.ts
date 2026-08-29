import {
    createChatContentAssembler,
    type ChatContentPageEnvelope,
} from './chatContentPage'

/**
 * The one client for `GET /api/chat-content/:chaId/:chatIndex[/page]`.
 *
 * The runtime hydrator (`NodeStorage.fetchChatContent`) and the legacy-to-SQL
 * migration both need the same route, the same `x-chat-id` header, the same
 * paging loop and the same "404 means no stored content" reading. They differ
 * only in what they do with the messages -- the hydrator wants a whole `Chat`
 * object, the migration wants each page turned into SQL statements and then
 * dropped -- so the loop lives here once, as a generator, and each caller
 * consumes it its own way.
 *
 * The decoder is injected rather than imported. `risuSave.ts` reaches the
 * Svelte runtime and the live database through its own imports; the migration
 * runs underneath all of that and passes the leaf decoder from
 * `risuSaveCodec.ts` instead.
 */

export const CHAT_CONTENT_TRANSFER_PAGE_SIZE = 200

export type ChatContentTransport = (
    input: string,
    init?: RequestInit,
) => Promise<Response>

export type SaveBlockDecoder = (bytes: Uint8Array) => unknown | Promise<unknown>

export interface ChatContentTarget {
    chaId: string
    /** The chat's position in the character's `chats` array. */
    chatIndex: number
    /** Sent as `x-chat-id`; the server 409s rather than serving a different chat. */
    chatId: string
}

export interface ChatContentBatch<TMessage> {
    kind: 'batch'
    messages: TMessage[]
    /** Index of the first message of this batch within the whole history. */
    offset: number
    /** The history length the server reports. Constant across the transfer. */
    total: number
}

/**
 * `absent` is the server answering 404 for both the paged and the whole-chat
 * route: it holds no content for this chat. Every other failure throws.
 *
 * Those are different facts and are never merged. A chat with no stored
 * content genuinely has no messages; a request that failed says nothing at all
 * about how long the history is, and treating it as empty is how a history gets
 * overwritten with nothing.
 */
export type ChatContentOutcome<TChat> =
    | { status: 'present'; chat: TChat; total: number }
    | { status: 'absent' }

/**
 * What the page stream yields.
 *
 * The end of a transfer is an event rather than the generator's return value
 * because a return value cannot be read by `for await`, and this project builds
 * with `strict: false`, where narrowing an `IteratorResult` on `done` does not
 * work. A `kind` discriminant works either way, and the terminal event is
 * impossible to skip by accident.
 */
export type ChatContentEvent<TMessage, TChat> =
    /**
     * The chat's own fields, without its messages. Always first, and always
     * before any batch: a consumer that writes messages into a store keyed by
     * chat has to be able to create the chat before the first message arrives.
     */
    | { kind: 'metadata'; chat: TChat; total: number }
    | ChatContentBatch<TMessage>
    | { kind: 'end'; outcome: ChatContentOutcome<TChat> }

export interface ChatContentRequestOptions {
    request: ChatContentTransport
    decode: SaveBlockDecoder
    target: ChatContentTarget
    pageSize?: number
}

function chatContentHeaders(chatId: string): HeadersInit {
    return { 'x-chat-id': chatId }
}

async function readBlock(response: Response, decode: SaveBlockDecoder): Promise<unknown> {
    return await decode(new Uint8Array(await response.arrayBuffer()))
}

/**
 * Yields one chat's history a page at a time, then one `end` event carrying the
 * chat's own fields and the server's message total.
 *
 * The `end` event matters as much as the pages: `total` is the only statement
 * anywhere of how long a history is -- a stub in `database.bin` carries no
 * count -- so a caller that wrote the messages somewhere else can check what it
 * wrote against what it was told to expect.
 */
export async function* streamChatContentBatches<TMessage, TChat extends object>(
    options: ChatContentRequestOptions,
): AsyncGenerator<ChatContentEvent<TMessage, TChat>, void, void> {
    const { request, decode, target } = options
    const pageSize = options.pageSize ?? CHAT_CONTENT_TRANSFER_PAGE_SIZE
    const base = `/api/chat-content/${encodeURIComponent(target.chaId)}/${target.chatIndex}`
    const assembler = createChatContentAssembler<TMessage, TChat>()

    let offset = 0
    while (true) {
        const response = await request(
            `${base}/page?offset=${offset}&limit=${pageSize}`,
            { headers: chatContentHeaders(target.chatId) },
        )
        if (response.status === 404 && offset === 0) {
            // Either this chat has no stored content, or the server predates the
            // paged route. The whole-chat route answers both questions.
            yield* wholeChatContentBatches<TMessage, TChat>(options, base)
            return
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `Chat content page failed (${response.status}) for chat ${target.chatId} ` +
                `at offset ${offset}`,
            )
        }
        const page = await readBlock(response, decode) as ChatContentPageEnvelope<TMessage, TChat>
        const messages = assembler.accept(page)
        if (offset === 0) {
            yield { kind: 'metadata', chat: page.chat as TChat, total: assembler.total ?? 0 }
        }
        yield { kind: 'batch', messages, offset, total: assembler.total ?? 0 }
        if (assembler.complete) break
        if (messages.length === 0) {
            throw new Error(
                `Chat content paging made no progress for chat ${target.chatId}: ` +
                `${assembler.received} of ${assembler.total} messages received`,
            )
        }
        offset = assembler.received
    }
    yield {
        kind: 'end',
        outcome: { status: 'present', chat: assembler.finishChat(), total: assembler.total ?? 0 },
    }
}

/** The unpaged route, used when the paged one is not there or has nothing. */
async function* wholeChatContentBatches<TMessage, TChat extends object>(
    options: ChatContentRequestOptions,
    base: string,
): AsyncGenerator<ChatContentEvent<TMessage, TChat>, void, void> {
    const { request, decode, target } = options
    const response = await request(base, { headers: chatContentHeaders(target.chatId) })
    if (response.status === 404) {
        yield { kind: 'end', outcome: { status: 'absent' } }
        return
    }
    if (response.status < 200 || response.status >= 300) {
        throw new Error(`Chat content failed (${response.status}) for chat ${target.chatId}`)
    }
    const decoded = await readBlock(response, decode)
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
        throw new Error(`Chat content for chat ${target.chatId} is not a chat object`)
    }
    const { message, ...chat } = decoded as { message?: TMessage[] }
    const messages = Array.isArray(message) ? message : []
    yield { kind: 'metadata', chat: chat as unknown as TChat, total: messages.length }
    yield { kind: 'batch', messages, offset: 0, total: messages.length }
    yield {
        kind: 'end',
        outcome: { status: 'present', chat: chat as unknown as TChat, total: messages.length },
    }
}

/**
 * The whole history in one object, for callers that want a `Chat`.
 *
 * `null` means the server holds no content for this chat -- the same "absent"
 * the streaming form reports, in the shape `fetchChatContent` has always
 * returned.
 */
export async function fetchWholeChatContent<TMessage, TChat extends object>(
    options: ChatContentRequestOptions,
): Promise<(TChat & { message: TMessage[] }) | null> {
    const messages: TMessage[] = []
    let outcome: ChatContentOutcome<TChat> | undefined
    for await (const event of streamChatContentBatches<TMessage, TChat>(options)) {
        if (event.kind === 'batch') messages.push(...event.messages)
        else if (event.kind === 'end') outcome = event.outcome
    }
    if (!outcome) throw new Error('Chat content stream ended without saying what it found')
    if (outcome.status === 'absent') return null
    return { ...outcome.chat, message: messages }
}
