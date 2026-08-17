function jsonObjectCandidates(value: string): unknown[] {
    const candidates: unknown[] = []
    let start = -1
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = 0; index < value.length; index += 1) {
        const character = value[index]
        if (inString) {
            if (escaped) escaped = false
            else if (character === '\\') escaped = true
            else if (character === '"') inString = false
            continue
        }
        if (character === '"') {
            inString = true
            continue
        }
        if (character === '{') {
            if (depth === 0) start = index
            depth += 1
        }
        else if (character === '}' && depth > 0) {
            depth -= 1
            if (depth === 0 && start >= 0) {
                try {
                    const parsed = JSON.parse(value.slice(start, index + 1))
                    if (typeof parsed === 'object'
                        && parsed !== null
                        && !Array.isArray(parsed)) {
                        candidates.push(parsed)
                    }
                }
                catch {
                    // Ignore prose braces and continue looking for one object.
                }
                start = -1
            }
        }
    }
    return candidates
}

export function stripModelReasoning(value: string): string {
    return value.replace(/<Thoughts>[\s\S]*?<\/Thoughts>/gi, '')
}

export function parseSingleJsonObject(value: string): unknown {
    if (typeof value !== 'string') {
        throw new Error('Model output must be a string')
    }
    const candidates = jsonObjectCandidates(
        stripModelReasoning(value)
    )
    if (candidates.length !== 1) {
        throw new Error('Model output must contain exactly one JSON object')
    }
    return candidates[0]
}

export function normalizeNarrativeBaseline(value: string): string {
    if (typeof value !== 'string') {
        throw new Error('Baseline output must be a string')
    }
    let normalized = stripModelReasoning(value).trim()
    const fenced = normalized.match(
        /^```(?:text|markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```$/i
    )
    if (fenced) normalized = fenced[1].trim()
    if (normalized.length === 0) {
        throw new Error('Baseline output is empty after normalization')
    }
    if (normalized.length > 12_000) {
        throw new Error('Baseline output exceeds 12000 characters')
    }
    return normalized
}
