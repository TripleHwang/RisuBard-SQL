export type FirstMessageStudioLocale = 'ko' | 'ja' | 'en'

export type FirstMessageStudioSkinPreset = 'minimal' | 'glass' | 'custom'

export interface FirstMessageStudioAppearance {
    preset: FirstMessageStudioSkinPreset
    accentColor: string
    backgroundColor: string
    surfaceColor: string
    textColor: string
    optionColumns: 1 | 2 | 3
    cornerRadius: number
    showHeader: boolean
    showProgress: boolean
    showNavigation: boolean
}

export interface FirstMessageStudioVariableChoice {
    label: FirstMessageStudioText
    value: FirstMessageStudioText
}

export interface FirstMessageStudioVariable {
    name: string
    label: FirstMessageStudioText
    defaultValue: string
    choices: FirstMessageStudioVariableChoice[]
}

export type FirstMessageStudioText = string | {
    ko: string
    ja: string
    en: string
}

export interface FirstMessageStudioEffect {
    variable: string
    value: FirstMessageStudioText
}

export interface FirstMessageStudioInput {
    variable: string
    label: FirstMessageStudioText
    placeholder?: FirstMessageStudioText
    required?: boolean
    displayVariable?: string
}

export interface FirstMessageStudioOption {
    id: string
    label: FirstMessageStudioText
    description?: FirstMessageStudioText
    badge?: FirstMessageStudioText
    effects: FirstMessageStudioEffect[]
    nextStageId?: string
    input?: FirstMessageStudioInput
    completes?: boolean
}

export interface FirstMessageStudioStage {
    id: string
    tag: FirstMessageStudioText
    title: FirstMessageStudioText
    speaker?: FirstMessageStudioText
    description: FirstMessageStudioText
    options: FirstMessageStudioOption[]
}

export interface FirstMessageStudioProject {
    version: 1
    enabled: boolean
    title: string
    completionVariable: string
    stageVariable?: string
    startStageId: string
    variables: FirstMessageStudioVariable[]
    stages: FirstMessageStudioStage[]
    appearance: FirstMessageStudioAppearance
    customCss: string
    customHtml: string
}

export interface FirstMessageStudioRuntime {
    stageId: string
    variables: Record<string, string>
    inputs: Record<string, string>
    history: string[]
    completed: boolean
    baseVariables: Record<string, string>
    stageVariable?: string
    stageIndexById: Record<string, number>
    locale: FirstMessageStudioLocale
}

export type FirstMessageStudioApplyResult = {
    runtime: FirstMessageStudioRuntime
    error?: 'unknown-option' | 'required-input'
}

const text = (ko: string, ja: string, en: string): FirstMessageStudioText => ({ ko, ja, en })
const cleanVariable = (value: unknown, fallback = '') => String(value ?? fallback).trim().replace(/^\$+/, '')
const cleanId = (value: unknown, fallback: string) => {
    const cleaned = String(value ?? '').trim().replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
    return cleaned || fallback
}

const appearancePresets: Record<Exclude<FirstMessageStudioSkinPreset, 'custom'>, FirstMessageStudioAppearance> = {
    minimal: {
        preset: 'minimal', accentColor: '#5b8cff', backgroundColor: '#111827', surfaceColor: '#1f2937', textColor: '#f8fafc',
        optionColumns: 1, cornerRadius: 14, showHeader: true, showProgress: true, showNavigation: true,
    },
    glass: {
        preset: 'glass', accentColor: '#65d9ff', backgroundColor: '#111827', surfaceColor: '#142c3c', textColor: '#f0fbff',
        optionColumns: 2, cornerRadius: 24, showHeader: true, showProgress: true, showNavigation: true,
    },
}

export function createStudioAppearance(preset: FirstMessageStudioSkinPreset): FirstMessageStudioAppearance {
    const base = preset === 'custom' ? appearancePresets.minimal : appearancePresets[preset]
    return { ...base, preset }
}

function normalizeColor(value: unknown, fallback: string): string {
    const color = String(value ?? '').trim().toLowerCase()
    return /^#[0-9a-f]{6}$/.test(color) ? color : fallback
}

function normalizeAppearance(value: unknown): FirstMessageStudioAppearance {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const requestedPreset = raw.preset
    const preset: FirstMessageStudioSkinPreset = requestedPreset === 'minimal' || requestedPreset === 'glass' || requestedPreset === 'custom'
        ? requestedPreset
        : 'minimal'
    const defaults = createStudioAppearance(preset)
    const columns = Math.min(3, Math.max(1, Math.round(Number(raw.optionColumns) || defaults.optionColumns))) as 1 | 2 | 3
    const requestedRadius = Number(raw.cornerRadius)
    return {
        preset,
        accentColor: normalizeColor(raw.accentColor, defaults.accentColor),
        backgroundColor: normalizeColor(raw.backgroundColor, defaults.backgroundColor),
        surfaceColor: normalizeColor(raw.surfaceColor, defaults.surfaceColor),
        textColor: normalizeColor(raw.textColor, defaults.textColor),
        optionColumns: columns,
        cornerRadius: Math.min(32, Math.max(0, Math.round(Number.isFinite(requestedRadius) ? requestedRadius : defaults.cornerRadius))),
        showHeader: raw.showHeader === undefined ? defaults.showHeader : Boolean(raw.showHeader),
        showProgress: raw.showProgress === undefined ? defaults.showProgress : Boolean(raw.showProgress),
        showNavigation: raw.showNavigation === undefined ? defaults.showNavigation : Boolean(raw.showNavigation),
    }
}

export function localizeStudioText(value: FirstMessageStudioText | undefined, locale: FirstMessageStudioLocale): string {
    if (typeof value === 'string') return value
    if (!value) return ''
    return value[locale] || value.ko || value.en || value.ja || ''
}

export function toFirstMessageStudioLocale(locale: string | undefined): FirstMessageStudioLocale {
    const normalized = String(locale ?? '').toLowerCase()
    if (normalized.startsWith('ja')) return 'ja'
    if (normalized.startsWith('ko')) return 'ko'
    return 'en'
}

export function resolveStudioLocale(variables: Record<string, string>, fallback: FirstMessageStudioLocale = 'ko'): FirstMessageStudioLocale {
    if (variables.cv_lang === '2') return 'ja'
    if (variables.cv_lang === '3') return 'en'
    if (variables.cv_lang === '1') return 'ko'
    return fallback
}

function normalizeText(value: unknown, fallback = ''): FirstMessageStudioText {
    if (typeof value === 'string') return value
    if (value && typeof value === 'object') {
        const candidate = value as Record<string, unknown>
        const ko = String(candidate.ko ?? candidate.en ?? candidate.ja ?? fallback)
        return {
            ko,
            ja: String(candidate.ja ?? ko),
            en: String(candidate.en ?? ko),
        }
    }
    return fallback
}

export function normalizeFirstMessageStudioProject(value: unknown): FirstMessageStudioProject {
    const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
    const rawStages = Array.isArray(raw.stages) && raw.stages.length > 0 ? raw.stages : [{
        id: 'welcome',
        tag: 'SETUP',
        title: 'Welcome',
        description: 'Choose an option.',
        options: [],
    }]
    const usedStageIds = new Set<string>()
    const stages: FirstMessageStudioStage[] = rawStages.map((entry, stageIndex) => {
        const source = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        let id = cleanId(source.id, `stage-${stageIndex + 1}`)
        while (usedStageIds.has(id)) id = `${id}-${stageIndex + 1}`
        usedStageIds.add(id)
        const options = Array.isArray(source.options) ? source.options.map((optionEntry, optionIndex) => {
            const option = optionEntry && typeof optionEntry === 'object' ? optionEntry as Record<string, unknown> : {}
            const inputSource = option.input && typeof option.input === 'object' ? option.input as Record<string, unknown> : undefined
            const effects = Array.isArray(option.effects) ? option.effects.flatMap((effectEntry) => {
                const effect = effectEntry && typeof effectEntry === 'object' ? effectEntry as Record<string, unknown> : {}
                const variable = cleanVariable(effect.variable)
                return variable ? [{ variable, value: normalizeText(effect.value) }] : []
            }) : []
            return {
                id: cleanId(option.id, `option-${optionIndex + 1}`),
                label: normalizeText(option.label, `Option ${optionIndex + 1}`),
                description: option.description === undefined ? undefined : normalizeText(option.description),
                badge: option.badge === undefined ? undefined : normalizeText(option.badge),
                effects,
                nextStageId: option.nextStageId ? cleanId(option.nextStageId, '') : undefined,
                input: inputSource ? {
                    variable: cleanVariable(inputSource.variable, `input_${stageIndex + 1}_${optionIndex + 1}`),
                    label: normalizeText(inputSource.label, 'Input'),
                    placeholder: inputSource.placeholder === undefined ? undefined : normalizeText(inputSource.placeholder),
                    required: Boolean(inputSource.required),
                    displayVariable: inputSource.displayVariable ? cleanVariable(inputSource.displayVariable) : undefined,
                } : undefined,
                completes: Boolean(option.completes),
            } satisfies FirstMessageStudioOption
        }) : []
        return {
            id,
            tag: normalizeText(source.tag, 'SETUP'),
            title: normalizeText(source.title, `Stage ${stageIndex + 1}`),
            speaker: source.speaker === undefined ? undefined : normalizeText(source.speaker),
            description: normalizeText(source.description),
            options,
        }
    })
    const requestedStart = cleanId(raw.startStageId, stages[0].id)
    const variables: FirstMessageStudioVariable[] = Array.isArray(raw.variables) ? raw.variables.flatMap((entry, index) => {
        const source = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {}
        const name = cleanVariable(source.name)
        if (!name) return []
        const choices = Array.isArray(source.choices) ? source.choices.map((choice) => {
            const candidate = choice && typeof choice === 'object' ? choice as Record<string, unknown> : {}
            return {
                label: normalizeText(candidate.label),
                value: normalizeText(candidate.value),
            }
        }) : []
        return [{
            name,
            label: normalizeText(source.label, name || `Variable ${index + 1}`),
            defaultValue: String(source.defaultValue ?? ''),
            choices,
        }]
    }) : []
    return {
        version: 1,
        enabled: raw.enabled === undefined ? false : Boolean(raw.enabled),
        title: String(raw.title ?? 'First Message Studio'),
        completionVariable: cleanVariable(raw.completionVariable, 'first_message_studio_done'),
        stageVariable: raw.stageVariable ? cleanVariable(raw.stageVariable) : undefined,
        startStageId: stages.some((stage) => stage.id === requestedStart) ? requestedStart : stages[0].id,
        variables,
        stages,
        appearance: normalizeAppearance(raw.appearance),
        customCss: String(raw.customCss ?? ''),
        customHtml: String(raw.customHtml ?? ''),
    }
}

export function createBlankStudioProject(): FirstMessageStudioProject {
    return normalizeFirstMessageStudioProject({
        version: 1,
        enabled: true,
        title: 'FIRST MESSAGE',
        completionVariable: 'first_message_studio_done',
        startStageId: 'welcome',
        variables: [],
        appearance: createStudioAppearance('minimal'),
        customCss: '',
        customHtml: '',
        stages: [{
            id: 'welcome',
            tag: text('시작', '開始', 'START'),
            title: text('첫 화면', '最初の画面', 'First screen'),
            description: text('질문이나 안내를 적어 주세요.', '質問や案内を入力してください。', 'Write a question or introduction.'),
            options: [],
        }],
    })
}

function projectVariables(project: FirstMessageStudioProject): Set<string> {
    const variables = new Set<string>([project.completionVariable])
    if (project.stageVariable) variables.add(project.stageVariable)
    for (const variable of project.variables) variables.add(variable.name)
    for (const stage of project.stages) {
        for (const option of stage.options) {
            for (const effect of option.effects) variables.add(effect.variable)
            if (option.input) {
                variables.add(option.input.variable)
                if (option.input.displayVariable) variables.add(option.input.displayVariable)
            }
        }
    }
    return variables
}

function stageForSavedValue(project: FirstMessageStudioProject, variables: Record<string, string>): string {
    const saved = project.stageVariable ? variables[project.stageVariable] : undefined
    if (!saved) return project.startStageId
    if (project.stages.some((stage) => stage.id === saved)) return saved
    const legacyIndex = Number(saved) - 1
    return project.stages[legacyIndex]?.id ?? project.startStageId
}

export function createStudioRuntime(projectValue: FirstMessageStudioProject, variables: Record<string, string> = {}, locale: FirstMessageStudioLocale = 'ko'): FirstMessageStudioRuntime {
    const project = normalizeFirstMessageStudioProject(projectValue)
    const baseVariables = { ...variables }
    const nextVariables = { ...variables }
    for (const variable of project.variables) nextVariables[variable.name] ??= variable.defaultValue
    nextVariables[project.completionVariable] ??= '0'
    const stageId = stageForSavedValue(project, nextVariables)
    if (project.stageVariable) nextVariables[project.stageVariable] = stageId
    const inputs: Record<string, string> = {}
    for (const stage of project.stages) for (const option of stage.options) if (option.input) inputs[option.input.variable] = nextVariables[option.input.variable] ?? ''
    return {
        stageId,
        variables: nextVariables,
        inputs,
        history: [],
        completed: nextVariables[project.completionVariable] === '1',
        baseVariables,
        stageVariable: project.stageVariable,
        stageIndexById: Object.fromEntries(project.stages.map((stage, index) => [stage.id, index])),
        locale,
    }
}

export function setStudioInput(runtime: FirstMessageStudioRuntime, variable: string, value: string): FirstMessageStudioRuntime {
    return { ...runtime, inputs: { ...runtime.inputs, [cleanVariable(variable)]: value } }
}

export function applyStudioOption(projectValue: FirstMessageStudioProject, runtime: FirstMessageStudioRuntime, optionId: string): FirstMessageStudioApplyResult {
    const project = normalizeFirstMessageStudioProject(projectValue)
    const stage = project.stages.find((candidate) => candidate.id === runtime.stageId)
    const option = stage?.options.find((candidate) => candidate.id === optionId)
    if (!stage || !option) return { runtime, error: 'unknown-option' }
    const inputValue = option.input ? (runtime.inputs[option.input.variable] ?? '').trim() : ''
    if (option.input?.required && !inputValue) return { runtime, error: 'required-input' }
    const locale = resolveStudioLocale(runtime.variables, runtime.locale)
    const variables = { ...runtime.variables }
    for (const effect of option.effects) variables[effect.variable] = localizeStudioText(effect.value, locale)
    if (option.input) {
        variables[option.input.variable] = inputValue
        if (option.input.displayVariable) variables[option.input.displayVariable] = inputValue
    }
    const completed = Boolean(option.completes)
    if (completed) variables[project.completionVariable] = '1'
    const nextStageId = option.nextStageId && project.stages.some((candidate) => candidate.id === option.nextStageId)
        ? option.nextStageId
        : runtime.stageId
    if (project.stageVariable) variables[project.stageVariable] = nextStageId
    return {
        runtime: {
            ...runtime,
            stageId: nextStageId,
            variables,
            history: nextStageId === runtime.stageId ? runtime.history : [...runtime.history, runtime.stageId],
            completed,
        },
    }
}

export function backStudioRuntime(runtime: FirstMessageStudioRuntime): FirstMessageStudioRuntime {
    if (runtime.history.length === 0) return runtime
    const history = runtime.history.slice(0, -1)
    const stageId = runtime.history[runtime.history.length - 1]
    const variables = { ...runtime.variables }
    if (runtime.stageVariable) variables[runtime.stageVariable] = stageId
    return { ...runtime, stageId, variables, history, completed: false }
}

export function resetStudioRuntime(projectValue: FirstMessageStudioProject, runtime: FirstMessageStudioRuntime): FirstMessageStudioRuntime {
    const project = normalizeFirstMessageStudioProject(projectValue)
    const variables = { ...runtime.baseVariables }
    for (const variable of projectVariables(project)) delete variables[variable]
    for (const variable of project.variables) variables[variable.name] = variable.defaultValue
    variables[project.completionVariable] = '0'
    if (project.stageVariable) variables[project.stageVariable] = project.startStageId
    return {
        ...createStudioRuntime(project, variables, runtime.locale),
        baseVariables: { ...runtime.baseVariables },
    }
}

export function readFirstMessageStudioVariables(
    scriptstate: Record<string, string | number | boolean> = {},
    defaultVariables = '',
): Record<string, string> {
    const variables: Record<string, string> = {}
    for (const line of defaultVariables.split(/\r?\n/)) {
        const match = line.match(/^\s*\$?([\w.-]+)\s*(?:=|:)\s*(.*?)\s*$/)
        if (match) variables[match[1]] = match[2]
    }
    for (const [key, value] of Object.entries(scriptstate)) {
        if (!key.startsWith('$')) continue
        variables[key.slice(1)] = String(value)
    }
    return variables
}

export function writeFirstMessageStudioVariables(
    scriptstate: Record<string, string | number | boolean> = {},
    variables: Record<string, string>,
): Record<string, string | number | boolean> {
    const next = { ...scriptstate }
    for (const [key, value] of Object.entries(variables)) next[`$${cleanVariable(key)}`] = value
    return next
}

export function shouldRenderFirstMessageStudio(
    firstMessage: boolean,
    project: FirstMessageStudioProject | undefined,
    scriptstate: Record<string, string | number | boolean> = {},
    defaultVariables = '',
): boolean {
    if (!firstMessage || !project?.enabled) return false
    const normalized = normalizeFirstMessageStudioProject(project)
    const variables = readFirstMessageStudioVariables(scriptstate, defaultVariables)
    return variables[normalized.completionVariable] !== '1'
}

function escapeStudioHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

export function interpolateStudioTemplate(template: string, variables: Record<string, string>): string {
    return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, name: string) => escapeStudioHtml(variables[name] ?? ''))
}

export function createScopedStudioCss(scopeId: string, css: string): string {
    const safeId = scopeId.replace(/[^a-zA-Z0-9_-]/g, '')
    if (!safeId || !css.trim()) return ''
    const sanitized = css
        .replace(/@import\s+[^;]+;?/gi, '')
        .replace(/@charset\s+[^;]+;?/gi, '')
        .replace(/<\/style/gi, '<\\/style')
        .replace(/expression\s*\(/gi, '')
        .replace(/url\s*\(\s*(['"]?)\s*javascript:/gi, 'url($1')
        .trim()
    return sanitized ? `@scope (#${safeId}) {\n${sanitized}\n}` : ''
}
