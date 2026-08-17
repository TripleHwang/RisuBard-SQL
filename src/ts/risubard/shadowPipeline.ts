import {
    compileContext,
    type ContextRole,
    type ContextSourceKind,
} from '../../../packages/risubard-core/src/contextCompiler'
import {
    compareShadowContext,
    type LegacyContextMessage,
    type ShadowContextReport,
} from './shadowContext'

export type ShadowPipelineMessage = LegacyContextMessage

export interface ShadowPipelineInput {
    legacyMessages: readonly ShadowPipelineMessage[]
    messageTokens: readonly number[]
    maxContextTokens: number
    reservedResponseTokens: number
    legacyEstimatedTokens: number
}

export type ShadowPipelineResult =
    | { status: 'success', report: ShadowContextReport }
    | { status: 'error', error: string }

export function createShadowContextReport(
    input: ShadowPipelineInput
): ShadowContextReport {
    if (input.legacyMessages.length !== input.messageTokens.length) {
        throw new Error('Shadow message and token counts must match')
    }

    const lastUserIndex = input.legacyMessages.findLastIndex(
        (message) => message.role === 'user'
    )
    const sources = input.legacyMessages.map((message, index) => {
        let kind: ContextSourceKind = 'recent'
        let role: ContextRole = message.role === 'function'
            ? 'tool'
            : message.role
        let priority = 50

        if (message.role === 'system') {
            kind = 'static'
            priority = 100
        }
        else if (message.role === 'function') {
            kind = 'tool'
            role = 'tool'
            priority = 80
        }
        else if (index === lastUserIndex) {
            kind = 'user-input'
        }

        return {
            id: `legacy-message:${index}`,
            kind,
            role,
            content: message.content,
            tokens: input.messageTokens[index],
            required: index === lastUserIndex,
            priority,
            occurredAt: index,
        }
    })
    const candidate = compileContext({
        budget: {
            maxContextTokens: input.maxContextTokens,
            reservedResponseTokens: input.reservedResponseTokens,
        },
        sources,
    })

    return compareShadowContext({
        legacyMessages: input.legacyMessages,
        legacyEstimatedTokens: input.legacyEstimatedTokens,
        candidate,
    })
}

export function tryCreateShadowContextReport(
    input: ShadowPipelineInput
): ShadowPipelineResult {
    try {
        return {
            status: 'success',
            report: createShadowContextReport(input),
        }
    }
    catch (error) {
        return {
            status: 'error',
            error: error instanceof Error ? error.message : String(error),
        }
    }
}

export async function tryCountShadowMessageTokens<T>(
    message: T,
    countTokens: (message: T) => Promise<number>
): Promise<number> {
    try {
        return await countTokens(message)
    }
    catch {
        return Number.NaN
    }
}
