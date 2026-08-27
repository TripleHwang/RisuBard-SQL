export interface ModelResponse {
    type: string
    result: unknown
    finishReason?: string
    noRetry?: boolean
    toolExecuted?: boolean
}

export class ModelOutputError extends Error {
    retryable: boolean
    validationHint?: string
    constructor(public readonly reason: 'empty' | 'truncated' | 'invalid-structure' | 'blocked') {
        super({
            empty: 'AI가 최종 답변 없이 빈 응답을 반환했습니다.',
            truncated: 'AI 응답이 출력 한도에서 잘렸습니다. 출력 토큰 한도를 늘리거나 한 번에 처리할 양을 줄여 주세요.',
            'invalid-structure': 'AI 응답 형식이 올바르지 않습니다. 검증되지 않은 내용은 저장하지 않았습니다.',
            blocked: '모델 제공자가 응답 생성을 중단했습니다.',
        }[reason])
        this.name = 'ModelOutputError'
        this.retryable = reason !== 'blocked'
    }
}

export function modelOutputRepairInstruction(error: ModelOutputError): string {
    return [
        `The previous response failed validation (${error.reason}).`,
        error.reason === 'truncated'
            ? 'The output was cut off. Be more concise while preserving all required fields, targets, and established facts; finish the entire response within the output limit.'
            : 'Return a complete final answer in exactly the requested format, with all required fields and no commentary or reasoning.',
        error.validationHint ?? '',
        'Follow the original schema and task; do not claim success without producing the requested output.',
    ].filter(Boolean).join('\n')
}

export function readModelResponseText(response: ModelResponse): string {
    if (response.type !== 'success') {
        throw new Error(typeof response.result === 'string' && response.result.trim()
            ? response.result : '모델 요청에 실패했습니다.')
    }
    const finish = response.finishReason?.toLowerCase()
    let failure: ModelOutputError | undefined
    if (['content_filter', 'safety', 'refusal', 'recitation', 'blocklist', 'prohibited_content'].includes(finish ?? '')) {
        failure = new ModelOutputError('blocked')
    } else if (['length', 'max_tokens', 'max_output_tokens'].includes(finish ?? '')) {
        failure = new ModelOutputError('truncated')
    }
    const text = typeof response.result === 'string' ? stripModelReasoning(response.result).trim() : ''
    if (!failure && !text) failure = new ModelOutputError('empty')
    if (failure) {
        if (response.noRetry || response.toolExecuted) failure.retryable = false
        throw failure
    }
    return text
}

// Retry only pure generation/validation, never the caller's writes or tool execution.
export async function runValidatedModelRequest<T>(options: {
    request(feedback?: ModelOutputError): Promise<ModelResponse>
    parse(text: string): T
    maxAttempts?: 1 | 2
}): Promise<T> {
    let feedback: ModelOutputError | undefined
    const attempts = options.maxAttempts === 1 ? 1 : 2
    for (let attempt = 0; attempt < attempts; attempt++) {
        let response: ModelResponse | undefined
        try {
            response = await options.request(feedback)
            const text = readModelResponseText(response)
            try {
                return options.parse(text)
            } catch (error) {
                if (error instanceof ModelOutputError) throw error
                const failure = new ModelOutputError('invalid-structure')
                // JSON parser errors may quote private model text. Only use
                // bounded contract-validator feedback, never replay raw output.
                if (error instanceof Error && !(error instanceof SyntaxError)) {
                    failure.validationHint = error.message.slice(0, 512)
                }
                throw failure
            }
        } catch (error) {
            if (!(error instanceof ModelOutputError)) throw error
            if (response?.noRetry || response?.toolExecuted) error.retryable = false
            if (!error.retryable || attempt + 1 >= attempts) throw error
            feedback = error
        }
    }
    throw feedback!
}
import { stripModelReasoning } from './modelOutput'
