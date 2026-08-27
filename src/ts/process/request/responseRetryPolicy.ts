import { ModelPresetAdapterError } from '../../preset/adapter/error'
import { ModelOutputError } from '../../../../packages/risubard-core/src/modelResponse'

export function normalizeRequestRetryLimit(value: number): number {
    return Number.isFinite(value) ? Math.min(20, Math.max(0, Math.floor(value))) : 0
}

export function filterResponseCharacters<T extends { type: string; result: unknown; noRetry?: boolean; toolExecuted?: boolean }>(response: T, scripts: readonly string[]): T | { type: 'fail'; result: string } {
    if (response.type !== 'success' || typeof response.result !== 'string'
        || response.noRetry || response.toolExecuted) return response
    for (const script of scripts) {
        let pattern: RegExp
        try { pattern = new RegExp(`\\p{Script=${script}}`, 'u') }
        catch { continue } // Old/imported settings may contain unsupported scripts.
        if (pattern.test(response.result)) {
            return { ...response, type: 'fail', result: '응답에 금지된 문자 집합이 포함되어 생성에 실패했습니다.' }
        }
    }
    return response
}

export function presetFailureRetryPolicy(error: unknown, aborted = false): { noRetry?: boolean; fallbackEligible?: boolean } {
    if (aborted || (error instanceof Error && error.name === 'AbortError')) {
        return { noRetry: true, fallbackEligible: false }
    }
    if (error instanceof ModelOutputError && !error.retryable) {
        return { noRetry: true, fallbackEligible: false }
    }
    return error instanceof ModelPresetAdapterError
        ? { noRetry: !error.retryable, fallbackEligible: error.fallbackEligible }
        : {}
}
