export function isCanonicalFilesChangedResponse(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const response = value as Record<string, unknown>
    return response.canonicalFilesChanged === true
        || response.code === 'CANONICAL_FILES_CHANGED'
}
