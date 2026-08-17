export function createModelAttemptOrder(
    fallbackModels: readonly string[]
): string[] {
    return [
        '',
        ...fallbackModels.filter((model) => model !== ''),
    ]
}

export function hasNextModelAttempt(
    attemptIndex: number,
    attemptCount: number
): boolean {
    return attemptIndex < attemptCount - 1
}
