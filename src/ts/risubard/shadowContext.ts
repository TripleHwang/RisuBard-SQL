import type {
    ContextPacket,
} from '../../../packages/risubard-core/src/contextCompiler'

export type LegacyContextRole = 'system' | 'user' | 'assistant' | 'function'

export interface LegacyContextMessage {
    role: LegacyContextRole
    content: string
    memo?: string
    name?: string
    removable?: boolean
    attr?: readonly string[]
    multimodals?: readonly unknown[]
    thoughts?: readonly string[]
    cachePoint?: boolean
}

export interface ShadowContextInput {
    legacyMessages: readonly LegacyContextMessage[]
    legacyEstimatedTokens: number
    candidate: ContextPacket
}

export interface ShadowContextReport {
    identicalMessages: boolean
    legacyMessageCount: number
    candidateMessageCount: number
    legacyEstimatedTokens: number
    candidateTokens: number
    selectedSourceIds: string[]
    omittedSourceIds: string[]
}

export function compareShadowContext(
    input: ShadowContextInput
): ShadowContextReport {
    const identicalMessages =
        input.legacyMessages.length === input.candidate.messages.length
        && input.legacyMessages.every((message, index) => {
            const candidateMessage = input.candidate.messages[index]
            const candidateRole = candidateMessage.role === 'tool'
                ? 'function'
                : candidateMessage.role
            const hasProviderMetadata =
                message.memo !== undefined
                || message.name !== undefined
                || message.removable !== undefined
                || message.attr !== undefined
                || message.multimodals !== undefined
                || message.thoughts !== undefined
                || message.cachePoint !== undefined

            return message.role === candidateRole
                && message.content === candidateMessage.content
                && !hasProviderMetadata
        })

    return {
        identicalMessages,
        legacyMessageCount: input.legacyMessages.length,
        candidateMessageCount: input.candidate.messages.length,
        legacyEstimatedTokens: input.legacyEstimatedTokens,
        candidateTokens: input.candidate.usedTokens,
        selectedSourceIds: [...input.candidate.selectedSourceIds],
        omittedSourceIds: [...input.candidate.omittedSourceIds],
    }
}
