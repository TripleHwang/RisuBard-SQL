export interface CbsConditionWarning { name: string; expected: number; actual: number }
export interface CbsVariableReference { name: string; values: string[]; reads: number; writes: number }
export function collectCbsVariables(source: string): CbsVariableReference[] {
    const found = new Map<string, CbsVariableReference>()
    const staticName = (name?: string) => !!name && !/[{}\r\n]/.test(name)
    const entry = (name: string) => {
        if (!found.has(name)) found.set(name, { name, values: [], reads: 0, writes: 0 })
        return found.get(name)!
    }
    const candidate = (name: string, value?: string) => {
        if (value === undefined || value.includes('{{')) return
        const values = entry(name).values
        if (!values.includes(value)) values.push(value)
    }
    const directVariable = (value: string) => {
        if (!value?.startsWith('{{') || tokenEnd(value, 0) !== value.length) return undefined
        const [name, key] = splitArguments(value.slice(2, -2))
        return name === 'getvar' && staticName(key) ? key : undefined
    }
    function walk(text: string, depth = 0) {
        if (depth > 32) return
        let cursor = 0
        while (cursor < text.length) {
            const from = text.indexOf('{{', cursor)
            if (from < 0) return
            const to = tokenEnd(text, from)
            if (to < 0) return
            cursor = to
            const inner = text.slice(from + 2, to - 2)
            if (inner.startsWith('//')) continue
            if (/^#(?:pure|puredisplay|pure_display|escape)$/.test(inner)) {
                const close = '{{/' + inner.slice(1) + '}}'
                const end = text.indexOf(close, cursor)
                if (end < 0) return
                cursor = end + close.length
                continue
            }
            const [name, ...args] = splitArguments(inner)
            if (['getvar', 'setvar', 'addvar', 'setdefaultvar'].includes(name) && staticName(args[0])) {
                const variable = entry(args[0])
                if (name === 'getvar') variable.reads++
                else variable.writes++
                if (name === 'setvar' || name === 'setdefaultvar') candidate(args[0], args[1])
            }
            // Include even ignored OR arguments as observed literals, never as declarations or enum constraints.
            if (['equal', 'notequal', 'not_equal', 'greater', 'less', 'greaterequal', 'greater_equal', 'lessequal', 'less_equal'].includes(name)) {
                const left = directVariable(args[0])
                const right = directVariable(args[1])
                if (left) candidate(left, args[1])
                if (right) candidate(right, args[0])
            }
            walk(inner, depth + 1)
        }
    }
    walk(source)
    return [...found.values()]
}
export interface CbsConditionPart {
    kind: 'text' | 'condition' | 'otherwise' | 'end'
    from: number
    to: number
    depth: number
}

// Read structure only. Never call the runtime parser: macros can change chat state.
function tokenEnd(source: string, from: number): number {
    let depth = 0
    for (let i = from; i < source.length - 1; i++) {
        if (source.startsWith('{{', i)) { depth++; i++ }
        else if (source.startsWith('}}', i)) {
            i++
            if (--depth === 0) return i + 1
        }
    }
    return -1
}

function splitArguments(source: string): string[] {
    const parts: string[] = []
    let start = 0
    for (let i = 0; i < source.length - 1; i++) {
        if (source.startsWith('{{', i)) {
            const end = tokenEnd(source, i)
            if (end < 0) return [source]
            i = end - 1
        } else if (source.startsWith('::', i)) {
            parts.push(source.slice(start, i))
            start = i + 2
            i++
        }
    }
    return [...parts, source.slice(start)]
}

export type CbsConditionExpression =
    | { kind: 'literal' | 'variable' | 'raw'; text: string }
    | { kind: 'comparison'; text: string; operator: string; left: CbsConditionExpression; right: CbsConditionExpression }
    | { kind: 'logical'; text: string; operator: 'OR' | 'AND' | 'NOT'; children: CbsConditionExpression[] }

export function summarizeCbsCondition(source: string): { text: string; expression: CbsConditionExpression; warnings: CbsConditionWarning[] } {
    const warnings: CbsConditionWarning[] = []
    const comparisons: Record<string, string> = {
        equal: '=', notequal: '≠', not_equal: '≠', greater: '>', less: '<',
        greaterequal: '≥', greater_equal: '≥', lessequal: '≤', less_equal: '≤',
    }
    const raw = (text: string): CbsConditionExpression => ({ kind: 'raw', text })
    function expression(value: string, depth = 0): CbsConditionExpression {
        if (depth > 32) return raw(value)
        if (!value.startsWith('{{') || tokenEnd(value, 0) !== value.length) {
            return value.includes('{{') ? raw(value) : { kind: 'literal', text: JSON.stringify(value) }
        }
        const [name, ...args] = splitArguments(value.slice(2, -2))
        const arity = name === 'not' || name === 'getvar' ? 1
            : name === 'or' || name === 'and' || comparisons[name] ? 2 : 0
        if (!arity || args.length < arity) return raw(value)
        if (args.length > arity) warnings.push({ name, expected: arity, actual: args.length })
        const render = (arg: string) => expression(arg, depth + 1)
        if (name === 'getvar') return /^[\w.-]+$/.test(args[0]) ? { kind: 'variable', text: `$${args[0]}` } : raw(value)
        const left = render(args[0])
        if (name === 'not') return { kind: 'logical', operator: 'NOT', children: [left], text: `NOT (${left.text})` }
        const right = render(args[1])
        if (name === 'or' || name === 'and') {
            const operator = name === 'or' ? 'OR' : 'AND'
            return { kind: 'logical', operator, children: [left, right], text: `(${left.text}) ${operator} (${right.text})` }
        }
        return { kind: 'comparison', operator: comparisons[name], left, right, text: `${left.text} ${comparisons[name]} ${right.text}` }
    }
    const inner = source.slice(2, -2)
    const condition = inner.match(/^#(?:if|if_pure|when) (.+)$/s)
    const tree = condition ? expression(condition[1]) : raw(inner)
    return { text: tree.text, expression: tree, warnings }
}

export function parseCbsConditionView(source: string): { valid: boolean; parts: CbsConditionPart[] } {
    const parts: CbsConditionPart[] = []
    const frames: Array<{ name: string; visible: boolean; hasElse: boolean }> = []
    const fallback = () => ({ valid: false, parts: [{ kind: 'text' as const, from: 0, to: source.length, depth: 0 }] })
    let cursor = 0
    let boundary = 0
    let depth = 0
    const textUntil = (to: number) => {
        const previous = parts.at(-1)?.kind
        if (to > boundary || previous === 'condition' || previous === 'otherwise') {
            parts.push({ kind: 'text', from: boundary, to, depth })
        }
    }
    while (cursor < source.length) {
        const from = source.indexOf('{{', cursor)
        if (from < 0) break
        const to = tokenEnd(source, from)
        if (to < 0) return fallback()
        cursor = to
        const token = source.slice(from + 2, to - 2)
        const opening = token.match(/^#([\w-]+)(?= |::|$)/)
        if (opening) {
            if (frames.length >= 128) return fallback()
            const name = opening[1]
            const visible = ['if', 'if_pure', 'when'].includes(name) && frames.every(frame => frame.visible)
            frames.push({ name, visible, hasElse: false })
            if (visible) {
                textUntil(from)
                parts.push({ kind: 'condition', from, to, depth })
                depth++
                boundary = to
            }
        } else if (/^\/[\w-]+$/.test(token)) {
            const frame = frames.pop()
            if (!frame || frame.name !== token.slice(1)) return fallback()
            if (frame.visible) {
                textUntil(from)
                depth--
                parts.push({ kind: 'end', from, to, depth })
                boundary = to
            }
        } else if (token === ':else' && frames.at(-1)?.visible) {
            const frame = frames.at(-1)!
            if (frame.name !== 'when' || frame.hasElse) return fallback()
            frame.hasElse = true
            textUntil(from)
            parts.push({ kind: 'otherwise', from, to, depth: depth - 1 })
            boundary = to
        }
    }
    if (frames.length) return fallback()
    textUntil(source.length)
    if (!parts.length) parts.push({ kind: 'text', from: 0, to: source.length, depth: 0 })
    return { valid: true, parts }
}
