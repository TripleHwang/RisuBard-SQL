export interface BardWikiHistoryMessage {
    chatId?: string
    risubardCanonicalReceipt?: {
        sourceMessageIds?: readonly string[]
    }
}

export function getBardWikiEvidenceMessageIds(
    messages: readonly BardWikiHistoryMessage[],
): Set<string> {
    const protectedIds = new Set<string>()
    for (const message of messages) {
        for (const sourceMessageId of message.risubardCanonicalReceipt?.sourceMessageIds ?? []) {
            if (sourceMessageId.length > 0) protectedIds.add(sourceMessageId)
        }
    }
    return protectedIds
}

export function canBranchFromMessage(
    messages: readonly BardWikiHistoryMessage[],
    index: number,
): boolean {
    if (!Number.isInteger(index) || index < 0 || index >= messages.length) return false
    if (getBardWikiEvidenceMessageIds(messages).size === 0) return true
    return index === messages.length - 1
}
