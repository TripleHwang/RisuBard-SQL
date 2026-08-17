export type GeminiThinkingConfig =
    | { thinkingLevel: 'LOW' | 'MEDIUM' | 'HIGH'; includeThoughts: boolean }
    | { thinkingBudget: unknown; includeThoughts: boolean }

export function resolveGeminiThinkingConfig(
    internalId: string | undefined,
    thinkingBudget: unknown,
    structured: boolean
): GeminiThinkingConfig {
    if (internalId && /^gemini-3-/.test(internalId)) {
        if (structured) {
            return {
                thinkingLevel: 'LOW',
                includeThoughts: false,
            }
        }
        const budgetNum = typeof thinkingBudget === 'number'
            ? thinkingBudget
            : Number(thinkingBudget)
        let thinkingLevel: 'LOW' | 'MEDIUM' | 'HIGH' = 'HIGH'
        if (internalId === 'gemini-3-flash-preview') {
            if (Number.isFinite(budgetNum) && budgetNum < 4_096) {
                thinkingLevel = 'LOW'
            }
            else if (Number.isFinite(budgetNum) && budgetNum < 16_384) {
                thinkingLevel = 'MEDIUM'
            }
        }
        else if (Number.isFinite(budgetNum) && budgetNum < 8_192) {
            thinkingLevel = 'LOW'
        }
        return { thinkingLevel, includeThoughts: true }
    }
    if (structured && internalId && /^gemini-2[.-]5(?:[.-]|$)/.test(internalId)) {
        return {
            thinkingBudget: 128,
            includeThoughts: false,
        }
    }
    return {
        thinkingBudget,
        includeThoughts: true,
    }
}
