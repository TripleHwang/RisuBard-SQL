export interface CbsVariableReference { name: string; values: string[]; reads: number; writes: number }
export interface CbsConditionPart { kind: 'text' | 'condition' | 'otherwise' | 'end'; from: number; to: number; depth: number }

function tokenEnd(source: string, from: number): number {
    let depth = 0
    for (let index = from; index < source.length - 1; index++) {
        if (source.startsWith('{{', index)) { depth++; index++ }
        else if (source.startsWith('}}', index)) { index++; if (--depth === 0) return index + 1 }
    }
    return -1
}

function parts(value: string): string[] { return value.split('::') }

/** Read-only structural parse: never invokes the macro runtime or mutates chat state. */
export function parseCbsConditionView(source: string): { valid: boolean; parts: CbsConditionPart[] } {
    const result: CbsConditionPart[] = []
    const frames: string[] = []
    let boundary = 0; let cursor = 0
    const text = (to: number) => { if (to > boundary) result.push({ kind: 'text', from: boundary, to, depth: frames.length }) }
    while (cursor < source.length) {
        const from = source.indexOf('{{', cursor); if (from < 0) break
        const to = tokenEnd(source, from); if (to < 0) return { valid: false, parts: [{ kind: 'text', from: 0, to: source.length, depth: 0 }] }
        cursor = to
        const token = source.slice(from + 2, to - 2)
        const open = token.match(/^#([\w-]+)(?: |::|$)/)?.[1]
        if (open && ['if', 'if_pure', 'when'].includes(open)) {
            text(from); result.push({ kind: 'condition', from, to, depth: frames.length }); frames.push(open); boundary = to
        } else if (token === ':else' && frames.at(-1) === 'when') {
            text(from); result.push({ kind: 'otherwise', from, to, depth: frames.length - 1 }); boundary = to
        } else if (/^\/[\w-]+$/.test(token)) {
            if (frames.at(-1) !== token.slice(1)) return { valid: false, parts: [{ kind: 'text', from: 0, to: source.length, depth: 0 }] }
            text(from); frames.pop(); result.push({ kind: 'end', from, to, depth: frames.length }); boundary = to
        }
    }
    if (frames.length) return { valid: false, parts: [{ kind: 'text', from: 0, to: source.length, depth: 0 }] }
    text(source.length)
    return { valid: true, parts: result.length ? result : [{ kind: 'text', from: 0, to: source.length, depth: 0 }] }
}

export function collectCbsVariables(source: string): CbsVariableReference[] {
    const found = new Map<string, CbsVariableReference>()
    const add = (name: string, mode: 'read' | 'write', value?: string) => {
        if (!name || /[{}\r\n]/.test(name)) return
        const item = found.get(name) ?? { name, values: [], reads: 0, writes: 0 }; found.set(name, item)
        mode === 'read' ? item.reads++ : item.writes++
        if (value && !value.includes('{{') && !item.values.includes(value)) item.values.push(value)
    }
    for (const match of source.matchAll(/\{\{(getvar|setvar|addvar|setdefaultvar)::([^}:]+)(?:::(.*?))?\}\}/gs)) {
        add(match[2], match[1] === 'getvar' ? 'read' : 'write', match[3])
    }
    return [...found.values()].sort((left, right) => left.name.localeCompare(right.name))
}
