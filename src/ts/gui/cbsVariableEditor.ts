import type { CbsVariableReference } from './cbsConditionView'

interface VariableChat {
    id?: string
    name: string
    scriptstate?: Record<string, string | number | boolean>
}
interface VariableCharacter {
    chaId: string
    name: string
    chatPage: number
    defaultVariables?: string
    chats: VariableChat[]
}
interface VariableDatabase { characters: VariableCharacter[]; templateDefaultVariables?: string }
export type CbsVariableTarget = 'chat' | 'default'
export interface CbsVariableContext {
    key: string
    label: string
    hasChat: boolean
    defaults: string
    templateDefaults: string
    state: Record<string, string | number | boolean>
    apply: (name: string, value: string, target: CbsVariableTarget) => boolean
}
export interface CbsVariableRow extends CbsVariableReference {
    value?: string
    defaultValue?: string
    templateValue?: string
    origin: 'chat' | 'character' | 'template' | 'unset'
}

function declarations(source: string): [string, string][] {
    // Match parseKeyValue exactly for effective values, but retain empty declarations in the list.
    return source.split('\n').map(line => line.split('=').slice(0, 2))
        .filter(parts => parts.length === 2 && parts[0]) as [string, string][]
}

export function buildCbsVariableRows(references: CbsVariableReference[], context?: CbsVariableContext): CbsVariableRow[] {
    const defaults = declarations(context?.defaults ?? '')
    const templates = declarations(context?.templateDefaults ?? '')
    const state = context?.state ?? {}
    const names = new Set([
        ...references.map(ref => ref.name), ...defaults.map(([key]) => key),
        ...templates.map(([key]) => key), ...Object.keys(state).filter(key => key.startsWith('$')).map(key => key.slice(1)),
    ])
    const byName = new Map(references.map(ref => [ref.name, ref]))
    return [...names].map(name => {
        const chatValue = Object.hasOwn(state, '$' + name) ? state['$' + name] : undefined
        const characterValue = defaults.find(([key, value]) => key === name && !!value)?.[1]
        const templateValue = templates.find(([key, value]) => key === name && !!value)?.[1]
        return {
            ...(byName.get(name) ?? { name, values: [], reads: 0, writes: 0 }),
            value: chatValue != null ? String(chatValue) : characterValue ?? templateValue,
            defaultValue: defaults.find(([key]) => key === name)?.[1],
            templateValue,
            origin: chatValue != null ? 'chat' : characterValue !== undefined ? 'character' : templateValue !== undefined ? 'template' : 'unset',
        }
    })
}

export function createCbsVariableContext(
    owner: VariableCharacter,
    chat: VariableChat | undefined,
    defaults: () => string,
    available: () => boolean = () => true,
): CbsVariableContext {
    return {
        key: JSON.stringify([owner.chaId, chat?.id, owner.chats.indexOf(chat)]),
        label: [owner.name, chat?.name].filter(Boolean).join(' · '),
        hasChat: !!chat,
        get defaults() { return owner.defaultVariables ?? '' },
        get templateDefaults() { return defaults() },
        get state() { return chat?.scriptstate ?? {} },
        apply(name, value, target) {
            if (!available() || !name || /[\r\n=]/.test(name)) return false
            if (target === 'chat') {
                if (!chat) return false
                chat.scriptstate ??= {}
                chat.scriptstate['$' + name] = value
                return true
            }
            if (/[\r\n=]/.test(value)) return false
            const source = owner.defaultVariables ?? ''
            const lines = source.split('\n')
            const index = lines.findIndex(line => line.split('=', 1)[0] === name)
            if (index >= 0) {
                lines[index] = name + '=' + value
                owner.defaultVariables = lines.join('\n')
            } else {
                owner.defaultVariables = source + (source && !source.endsWith('\n') ? '\n' : '') + name + '=' + value
            }
            return true
        },
    }
}

export function lorebookVariableContext(db: VariableDatabase, scopeKey?: string): CbsVariableContext | undefined {
    if (!scopeKey) return undefined
    try {
        const [root, kind, ownerId, chatId] = JSON.parse(scopeKey)
        if (root !== 'lorebook' || !['character', 'chat'].includes(kind)) return undefined
        const owner = db.characters?.find(character => character.chaId === ownerId)
        if (!owner) return undefined
        const chat = kind === 'chat' ? owner.chats.find(item => item.id === chatId) : owner.chats[owner.chatPage]
        if (kind === 'chat' && !chat) return undefined
        return createCbsVariableContext(owner, chat, () => db.templateDefaultVariables ?? '',
            () => db.characters.includes(owner) && (!chat || owner.chats.includes(chat)))
    } catch { return undefined }
}
