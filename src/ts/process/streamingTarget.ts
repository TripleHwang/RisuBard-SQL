import type { character, Chat, Message } from '../storage/database.svelte'

export interface StreamingChatTarget {
    character: character
    chat: Chat
}

export interface StreamingMessageTarget extends StreamingChatTarget {
    message: Message
    index: number
}

/** Re-finds a chat by durable ownership after an async streaming boundary. */
export function findStreamingChat(
    characters: readonly character[], characterId: string, chatId: string,
): StreamingChatTarget | undefined {
    const character = characters.find((item) => item?.chaId === characterId)
    const chat = character?.chats?.find((item) => item?.id === chatId)
    return character && chat ? { character, chat } : undefined
}

/** Re-finds the exact streamed row; never falls back to a mutable index. */
export function findStreamingMessageTarget(
    characters: readonly character[], characterId: string, chatId: string, messageId: string,
): StreamingMessageTarget | undefined {
    const target = findStreamingChat(characters, characterId, chatId)
    const index = target?.chat.message.findIndex((item) => item?.chatId === messageId) ?? -1
    if (!target || index < 0) return undefined
    const message = target.chat.message[index]
    return message ? { ...target, message, index } : undefined
}
