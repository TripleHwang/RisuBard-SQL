import {
    setStudioTextLanguage,
    type FirstMessageStudioProject,
    type FirstMessageStudioText,
} from './firstMessageStudio'

export interface FirstMessageStudioTranslationEntry {
    id: string
    text: string
}

const part = (value: string) => encodeURIComponent(value)

function exactText(value: FirstMessageStudioText | undefined, language: string): string {
    if (typeof value === 'string') return value.trim()
    return String(value?.[language] ?? '').trim()
}

function visitVisibleTexts(
    project: FirstMessageStudioProject,
    visit: (id: string, value: FirstMessageStudioText, assign: (value: FirstMessageStudioText) => void) => void,
) {
    visit('project.title', project.title, (value) => project.title = value)
    project.variables.forEach((variable, variableIndex) => {
        const variableId = `${part(variable.name || String(variableIndex))}`
        visit(`variable.${variableId}.label`, variable.label, (value) => variable.label = value)
        variable.choices.forEach((choice, choiceIndex) => {
            visit(`variable.${variableId}.choice.${choiceIndex}.label`, choice.label, (value) => choice.label = value)
        })
    })
    project.stages.forEach((stage) => {
        const stageId = part(stage.id)
        visit(`stage.${stageId}.tag`, stage.tag, (value) => stage.tag = value)
        visit(`stage.${stageId}.title`, stage.title, (value) => stage.title = value)
        if (stage.speaker) visit(`stage.${stageId}.speaker`, stage.speaker, (value) => stage.speaker = value)
        visit(`stage.${stageId}.description`, stage.description, (value) => stage.description = value)
        stage.options.forEach((option) => {
            const optionId = part(option.id)
            visit(`stage.${stageId}.option.${optionId}.label`, option.label, (value) => option.label = value)
            if (option.description) visit(`stage.${stageId}.option.${optionId}.description`, option.description, (value) => option.description = value)
            if (option.badge) visit(`stage.${stageId}.option.${optionId}.badge`, option.badge, (value) => option.badge = value)
            if (option.input) {
                visit(`stage.${stageId}.option.${optionId}.input.label`, option.input.label, (value) => option.input!.label = value)
                if (option.input.placeholder) {
                    visit(`stage.${stageId}.option.${optionId}.input.placeholder`, option.input.placeholder, (value) => option.input!.placeholder = value)
                }
            }
            if (option.presentation) {
                if (option.presentation.speaker) {
                    visit(`stage.${stageId}.option.${optionId}.presentation.speaker`, option.presentation.speaker, (value) => option.presentation!.speaker = value)
                }
                visit(`stage.${stageId}.option.${optionId}.presentation.description`, option.presentation.description, (value) => option.presentation!.description = value)
            }
        })
    })
    project.scenarioRules.forEach((rule) => {
        visit(`scenario.${part(rule.id)}.message`, rule.message, (value) => rule.message = value)
    })
}

export function collectFirstMessageStudioTranslationEntries(
    project: FirstMessageStudioProject,
    sourceLanguage: string,
): FirstMessageStudioTranslationEntry[] {
    const entries: FirstMessageStudioTranslationEntry[] = []
    visitVisibleTexts(project, (id, value) => {
        const source = exactText(value, sourceLanguage)
        if (source) entries.push({ id, text: source })
    })
    return entries
}

export function buildFirstMessageStudioTranslationPrompt(
    entries: FirstMessageStudioTranslationEntry[],
    sourceLanguage: string,
    targetLanguage: string,
): string {
    return [
        `Translate the following First Message Studio UI strings from ${sourceLanguage} to ${targetLanguage}.`,
        'Preserve meaning, tone, punctuation, placeholders, and line breaks. Do not translate ids.',
        'Return JSON only in exactly this shape: {"translations":[{"id":"same id","text":"translated text"}]}.',
        'Return every item once, in the same order. Do not add commentary or Markdown fences.',
        JSON.stringify({ items: entries }),
    ].join('\n')
}

export function parseFirstMessageStudioTranslations(response: string, expectedIds: string[]): Record<string, string> {
    const fenced = response.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
    const source = fenced?.[1] ?? response.trim()
    let parsed: unknown
    try {
        parsed = JSON.parse(source)
    }
    catch {
        throw new Error('translation-response-invalid')
    }
    const raw = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    if (!Array.isArray(raw.translations)) throw new Error('translation-response-invalid')
    const expected = new Set(expectedIds)
    const translations: Record<string, string> = {}
    for (const item of raw.translations) {
        const entry = item && typeof item === 'object' ? item as Record<string, unknown> : {}
        const id = String(entry.id ?? '')
        if (!expected.has(id) || typeof entry.text !== 'string' || id in translations) throw new Error('translation-response-invalid')
        translations[id] = entry.text
    }
    if (Object.keys(translations).length !== expected.size) throw new Error('translation-response-incomplete')
    return translations
}

export function applyFirstMessageStudioTranslations(
    project: FirstMessageStudioProject,
    targetLanguage: string,
    translations: Record<string, string>,
): FirstMessageStudioProject {
    const translated = structuredClone(project)
    visitVisibleTexts(translated, (id, value, assign) => {
        if (!(id in translations)) return
        assign(setStudioTextLanguage(value, targetLanguage, translations[id], translated.localization.languages))
    })
    return translated
}
