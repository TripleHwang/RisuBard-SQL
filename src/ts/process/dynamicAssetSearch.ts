export type DynamicAssetReference = {
    full: string
    type: string
    assetName: string
}

export type DynamicAssetSearchCandidate = DynamicAssetReference & {
    cacheKey: string
}

/**
 * Applies dynamic-asset results already known in memory and returns only the
 * references that still need an embedding lookup. Chat hydration invokes
 * edit-display scripts for every mounted row, so constructing a HypaProcesser
 * for exact or cached references turns a cheap render into repeated storage
 * and embedding-cache work.
 */
export function prepareDynamicAssetSearch(
    data: string,
    charId: string,
    assetNames: readonly string[],
    matches: Iterable<DynamicAssetReference>,
    cache: ReadonlyMap<string, string>,
): { data: string, unresolved: DynamicAssetSearchCandidate[] } {
    const unresolved: DynamicAssetSearchCandidate[] = []
    for (const match of matches) {
        if (match.type === 'emotion' || match.type === 'source') {
            continue
        }

        const cacheKey = charId + '::' + match.assetName
        const cached = cache.get(cacheKey)
        if (cached !== undefined) {
            data = data.replaceAll(match.full, `{{${match.type}::${cached}}}`)
            continue
        }

        if (!assetNames.includes(match.assetName)) {
            unresolved.push({ ...match, cacheKey })
        }
    }
    return { data, unresolved }
}
