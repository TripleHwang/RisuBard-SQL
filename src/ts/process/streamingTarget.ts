export interface StreamingMessageTarget {
    chatId?: string
}

export interface StreamingChatTarget<Message extends StreamingMessageTarget> {
    id?: string
    message: Message[]
}

export interface StreamingCharacterTarget<Chat extends StreamingChatTarget<StreamingMessageTarget>> {
    chaId?: string
    chats?: Chat[]
}

/** Resolves durable stream ownership again after any async boundary. */
export function findStreamingMessageTarget<
    Message extends StreamingMessageTarget,
    Chat extends StreamingChatTarget<Message>,
    Character extends StreamingCharacterTarget<Chat>,
>(characters: readonly Character[], characterId: string, chatId: string, messageId: string): {
    chat: Chat
    message: Message
    index: number
} | undefined {
    const character = characters.find((item) => item?.chaId === characterId)
    const chat = character?.chats?.find((item) => item?.id === chatId)
    const index = chat?.message.findIndex((item) => item?.chatId === messageId) ?? -1
    if (!chat || index < 0) return undefined
    const message = chat.message[index]
    return message ? { chat, message, index } : undefined
}
