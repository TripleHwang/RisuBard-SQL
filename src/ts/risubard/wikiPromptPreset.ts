export type WikiPromptStage = 'analysis' | 'canonical-rewrite' | 'both'
export type WikiPromptBlockType = 'core-ref' | 'text' | 'injection'

export interface WikiPromptBlock {
    id: string
    type: WikiPromptBlockType
    name: string
    target: WikiPromptStage
    enabled: boolean
    readonly: boolean
    content?: string
}

export interface WikiPromptPreset {
    schemaVersion: 1
    id: string
    name: string
    revision: number
    blocks: WikiPromptBlock[]
}

export interface WikiPromptPresetState {
    presets: WikiPromptPreset[]
    chatPresetId: string
}

export interface CompiledWikiPromptGuide {
    analysis: string
    canonicalRewrite: string
}

const MAX_PRESETS = 64
const MAX_EDITABLE_BLOCKS = 32
const MAX_BLOCK_CONTENT = 8_000
const MAX_COMPILED_GUIDE = 24_000

const REQUIRED_PREFIX: readonly WikiPromptBlock[] = [
    {
        id: 'core-evidence-contract',
        type: 'core-ref',
        name: 'Evidence and fact boundary',
        target: 'both',
        enabled: true,
        readonly: true,
    },
    {
        id: 'core-analysis-contract',
        type: 'core-ref',
        name: 'Memory analysis contract',
        target: 'analysis',
        enabled: true,
        readonly: true,
    },
]

const REQUIRED_SUFFIX: readonly WikiPromptBlock[] = [
    {
        id: 'character-wiki-guide',
        type: 'injection',
        name: 'Character Wiki Guide Injection',
        target: 'both',
        enabled: true,
        readonly: true,
    },
    {
        id: 'chat-wiki-guide',
        type: 'injection',
        name: 'Chat Wiki Guide Injection',
        target: 'both',
        enabled: true,
        readonly: true,
    },
    {
        id: 'core-output-contract',
        type: 'core-ref',
        name: 'Structured output contract',
        target: 'both',
        enabled: true,
        readonly: true,
    },
]

const RESERVED_IDS = new Set([
    ...REQUIRED_PREFIX.map((block) => block.id),
    ...REQUIRED_SUFFIX.map((block) => block.id),
])

function boundedText(value: unknown, maximum: number): string {
    return typeof value === 'string' ? value.trim().slice(0, maximum) : ''
}

function normalizeTarget(value: unknown): WikiPromptStage {
    return value === 'analysis'
        || value === 'canonical-rewrite'
        || value === 'both'
        ? value
        : 'both'
}

function normalizeEditableBlocks(value: unknown): WikiPromptBlock[] {
    if (!Array.isArray(value)) return []
    const seen = new Set<string>()
    const blocks: WikiPromptBlock[] = []
    for (const raw of value) {
        if (!raw || typeof raw !== 'object') continue
        const source = raw as Record<string, unknown>
        const id = boundedText(source.id, 120)
        if (!id || RESERVED_IDS.has(id) || seen.has(id)) continue
        if (source.type !== 'text') continue
        seen.add(id)
        blocks.push({
            id,
            type: 'text',
            name: boundedText(source.name, 80) || 'Wiki Guide',
            target: normalizeTarget(source.target),
            enabled: source.enabled !== false,
            readonly: false,
            content: boundedText(source.content, MAX_BLOCK_CONTENT),
        })
        if (blocks.length >= MAX_EDITABLE_BLOCKS) break
    }
    return blocks
}

function normalizePreset(value: unknown, idFactory: () => string): WikiPromptPreset {
    const source = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {}
    const editable = normalizeEditableBlocks(source.blocks)
    const hasMain = editable.some((block) => block.id === 'main-wiki-guide')
    if (!hasMain) {
        editable.unshift({
            id: 'main-wiki-guide',
            type: 'text',
            name: 'Main Wiki Guide',
            target: 'both',
            enabled: true,
            readonly: false,
            content: '',
        })
    }
    return {
        schemaVersion: 1,
        id: boundedText(source.id, 120) || idFactory(),
        name: boundedText(source.name, 120) || 'Default Wiki Prompt',
        revision: Number.isSafeInteger(source.revision)
            ? Math.max(1, Math.min(2_147_483_647, source.revision as number))
            : 1,
        blocks: [
            ...REQUIRED_PREFIX.map((block) => ({ ...block })),
            ...editable,
            ...REQUIRED_SUFFIX.map((block) => ({ ...block })),
        ],
    }
}

export function createDefaultWikiPromptPreset(id: string): WikiPromptPreset {
    return normalizePreset({ id }, () => id)
}

export function normalizeWikiPromptPresetState(
    value: unknown,
    idFactory: () => string
): WikiPromptPresetState {
    const source = value && typeof value === 'object'
        ? value as Record<string, unknown>
        : {}
    const rawPresets = Array.isArray(source.presets)
        ? source.presets.slice(0, MAX_PRESETS)
        : []
    const presets = rawPresets.map((preset) => normalizePreset(preset, idFactory))
    if (presets.length === 0) presets.push(createDefaultWikiPromptPreset(idFactory()))
    const ids = new Set(presets.map((preset) => preset.id))
    const fallbackId = presets[0].id
    const chatPresetId = boundedText(source.chatPresetId, 120)
    return {
        presets,
        chatPresetId: ids.has(chatPresetId) ? chatPresetId : fallbackId,
    }
}

function targetIncludes(target: WikiPromptStage, stage: Exclude<WikiPromptStage, 'both'>): boolean {
    return target === 'both' || target === stage
}

function compileStage(
    preset: WikiPromptPreset,
    stage: Exclude<WikiPromptStage, 'both'>,
    characterGuide: string,
    chatGuide: string
): string {
    const sections: string[] = []
    for (const block of preset.blocks) {
        if (!block.enabled || !targetIncludes(block.target, stage)) continue
        if (block.type === 'text') {
            const content = boundedText(block.content, MAX_BLOCK_CONTENT)
            if (content) sections.push(`## ${block.name}\n${content}`)
        }
        else if (block.id === 'character-wiki-guide') {
            const content = boundedText(characterGuide, MAX_BLOCK_CONTENT)
            if (content) sections.push(`## Character Wiki Guide\n${content}`)
        }
        else if (block.id === 'chat-wiki-guide') {
            const content = boundedText(chatGuide, MAX_BLOCK_CONTENT)
            if (content) sections.push(`## Chat Wiki Guide\n${content}`)
        }
    }
    return sections.join('\n\n').slice(0, MAX_COMPILED_GUIDE)
}

export function compileWikiPromptGuide(
    preset: WikiPromptPreset,
    injections: {
        characterGuide?: string
        chatGuide?: string
    } = {}
): CompiledWikiPromptGuide {
    const normalized = normalizePreset(preset, () => preset.id)
    return {
        analysis: compileStage(
            normalized,
            'analysis',
            injections.characterGuide ?? '',
            injections.chatGuide ?? ''
        ),
        canonicalRewrite: compileStage(
            normalized,
            'canonical-rewrite',
            injections.characterGuide ?? '',
            injections.chatGuide ?? ''
        ),
    }
}

export function resolveWikiPromptPreset(
    presets: readonly WikiPromptPreset[] | null | undefined,
    presetId: string | null | undefined
): WikiPromptPreset | undefined {
    if (!Array.isArray(presets) || presets.length === 0) return undefined
    return presets.find((preset) => preset.id === presetId) ?? presets[0]
}

export function duplicateWikiPromptPreset(
    preset: WikiPromptPreset,
    id: string
): WikiPromptPreset {
    const copy = normalizePreset(preset, () => id)
    return {
        ...copy,
        id,
        name: `${copy.name} Copy`.slice(0, 120),
        revision: 1,
        blocks: copy.blocks.map((block) => ({ ...block })),
    }
}

export function deleteWikiPromptPreset(
    presets: readonly WikiPromptPreset[],
    presetId: string
): { presets: WikiPromptPreset[]; deleted: boolean } {
    if (presets.length <= 1 || !presets.some((preset) => preset.id === presetId)) {
        return { presets: [...presets], deleted: false }
    }
    return {
        presets: presets.filter((preset) => preset.id !== presetId),
        deleted: true,
    }
}

export function serializeWikiPromptPreset(preset: WikiPromptPreset): string {
    return JSON.stringify({
        type: 'risubard-wiki-prompt-preset',
        schemaVersion: 1,
        preset: normalizePreset(preset, () => preset.id),
    }, null, 2)
}

export function parseWikiPromptPreset(
    text: string,
    idFactory: () => string
): WikiPromptPreset {
    const parsed = JSON.parse(text) as unknown
    const source = parsed && typeof parsed === 'object'
        && (parsed as Record<string, unknown>).type === 'risubard-wiki-prompt-preset'
        ? (parsed as Record<string, unknown>).preset
        : parsed
    const preset = normalizePreset(source, idFactory)
    return {
        ...preset,
        id: idFactory(),
        revision: 1,
    }
}
