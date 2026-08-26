export type MessageReloadPointers = Record<string, number>

export function messageReloadKey(message: { chatId?: string }): string | null {
    return message.chatId || null
}

export function bumpMessageReloadPointer(pointers: MessageReloadPointers, messageId: string | null): MessageReloadPointers {
    if (!messageId) return pointers
    return { ...pointers, [messageId]: (pointers[messageId] ?? 0) + 1 }
}
