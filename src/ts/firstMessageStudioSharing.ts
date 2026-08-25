import type { triggerscript } from './process/triggers'
import {
    localizeStudioText,
    normalizeFirstMessageStudioProject,
    type FirstMessageStudioProject,
    type FirstMessageStudioText,
} from './firstMessageStudio'

const PROJECT_TYPE = 'risubard-first-message-studio'
const TRIGGER_PREFIX = '[First Message Studio] '
const VARIABLES_BEGIN = '# First Message Studio:begin'
const VARIABLES_END = '# First Message Studio:end'

export interface FirstMessageStudioCompatibilityResult {
    firstMessage: string
    triggers: triggerscript[]
    defaultVariables: string
}

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
}

function cbsValue(value: FirstMessageStudioText | undefined, project: FirstMessageStudioProject, html = false): string {
    const render = (entry: string) => html ? escapeHtml(entry) : entry
    if (typeof value === 'string') return render(value)
    return project.localization.languages.map((language) => {
        const translated = localizeStudioText(value, language.id)
        return `{{#if {{equal::{{getvar::${project.localization.variable}}}::${language.value}}}}}${render(translated)}{{/if}}`
    }).join('')
}

function compatibilityStageVariable(project: FirstMessageStudioProject): string {
    return project.stageVariable || '__first_message_studio_stage'
}

function triggerName(stageId: string, optionId: string): string {
    return `${TRIGGER_PREFIX}${stageId}/${optionId}`
}

function compileTrigger(project: FirstMessageStudioProject, stageId: string, option: FirstMessageStudioProject['stages'][number]['options'][number]): triggerscript {
    const effect: triggerscript['effect'] = []
    if (option.input) {
        effect.push({
            type: 'v2GetAlertInput',
            display: cbsValue(option.input.label, project),
            displayType: 'value',
            outputVar: option.input.variable,
            indent: 0,
        })
        if (option.input.displayVariable) {
            effect.push({ type: 'setvar', operator: '=', var: option.input.displayVariable, value: `{{getvar::${option.input.variable}}}` })
        }
    }
    for (const assignment of option.effects) {
        effect.push({ type: 'setvar', operator: '=', var: assignment.variable, value: cbsValue(assignment.value, project) })
    }
    const nextStage = option.nextStageId && project.stages.some((stage) => stage.id === option.nextStageId)
        ? option.nextStageId
        : stageId
    effect.push({ type: 'setvar', operator: '=', var: compatibilityStageVariable(project), value: nextStage })
    if (option.completes) effect.push({ type: 'setvar', operator: '=', var: project.completionVariable, value: '1' })
    return { comment: triggerName(stageId, option.id), type: 'manual', conditions: [], effect }
}

function compileOptions(project: FirstMessageStudioProject, stage: FirstMessageStudioProject['stages'][number]): string {
    return stage.options.map((option) => {
        const badge = option.badge ? `<small>${cbsValue(option.badge, project, true)}</small>` : ''
        const description = option.description ? `<span>${cbsValue(option.description, project, true)}</span>` : ''
        return `<button class="fms-option" type="button" risu-trigger="${escapeHtml(triggerName(stage.id, option.id))}"><strong>${cbsValue(option.label, project, true)}</strong>${description}${badge}</button>`
    }).join('')
}

function compilePresentations(project: FirstMessageStudioProject, stage: FirstMessageStudioProject['stages'][number], stageIndex: number): string {
    if (!stage.optionPresentationEnabled || stage.options.length === 0) return ''
    const presentations = stage.options.map((option, optionIndex) => {
        const presentation = option.presentation
        const speaker = presentation?.speaker ? `<b>${cbsValue(presentation.speaker, project, true)}</b>` : ''
        const description = presentation ? cbsValue(presentation.description, project, true) : ''
        const assetName = presentation?.imageEnabled
            ? (presentation.imageAssetName ?? '').replace(/[{}]/g, '')
            : ''
        const positionClass = `fms-presentation-position-${stageIndex}-${optionIndex}`
        const imageStyle = presentation?.imageFrame === 'contain'
            ? 'width:auto!important;height:auto!important;max-width:100%!important;max-height:17rem!important;margin:0!important;object-fit:contain!important;object-position:50% 50%!important'
            : `width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;object-fit:cover!important;object-position:${presentation?.imagePositionX ?? 50}% ${presentation?.imagePositionY ?? 50}%!important`
        const image = assetName
            ? `<div class="fms-presentation-image-frame frame-${presentation?.imageFrame ?? 'contain'} ${positionClass}"><img src="{{raw::${escapeHtml(assetName)}}}" alt="${cbsValue(option.label, project, true)}" style="${imageStyle}"></div>`
            : ''
        return `<div class="fms-presentation${image ? ' with-image' : ''}">${image}<div class="fms-presentation-copy">${speaker}<p>${description}</p></div></div>`
    }).join('')
    const stageClass = `.fms-stage-${stageIndex}`
    const interactionCss = stage.options.slice(1).map((_, offset) => {
        const optionIndex = offset + 2
        return `${stageClass}:has(.fms-option:nth-child(${optionIndex}):hover) .fms-presentation{display:none}${stageClass}:has(.fms-option:nth-child(${optionIndex}):hover) .fms-presentation:nth-child(${optionIndex}){display:grid}${stageClass}:has(.fms-option:nth-child(${optionIndex}):focus-visible) .fms-presentation{display:none}${stageClass}:has(.fms-option:nth-child(${optionIndex}):focus-visible) .fms-presentation:nth-child(${optionIndex}){display:grid}`
    }).join('')
    const positionCss = stage.options.map((option, optionIndex) => {
        const presentation = option.presentation
        return `.fms-presentation-position-${stageIndex}-${optionIndex} img{object-position:${presentation?.imagePositionX ?? 50}% ${presentation?.imagePositionY ?? 50}%!important}`
    }).join('')
    return `<style>[data-first-message-studio-compatible] .fms-presentations{margin:.8rem 0}[data-first-message-studio-compatible] .fms-presentation{display:none;gap:.65rem}[data-first-message-studio-compatible] .fms-presentation:first-child{display:grid}[data-first-message-studio-compatible] .fms-presentation-image-frame{display:grid;width:100%;place-items:center;overflow:hidden;margin-inline:auto;border:1px solid color-mix(in srgb,${project.appearance.accentColor} 30%,transparent);border-radius:${Math.max(4, Math.round(project.appearance.cornerRadius * .55))}px;background:color-mix(in srgb,${project.appearance.backgroundColor} 62%,${project.appearance.surfaceColor})}[data-first-message-studio-compatible] .fms-presentation-image-frame.frame-contain{max-height:18rem;padding:.5rem}[data-first-message-studio-compatible] .fms-presentation-image-frame.frame-square{width:min(100%,20rem);aspect-ratio:1}[data-first-message-studio-compatible] .fms-presentation-image-frame.frame-landscape{aspect-ratio:16/9}[data-first-message-studio-compatible] .fms-presentation-image-frame.frame-portrait{width:min(100%,18rem);aspect-ratio:3/4}[data-first-message-studio-compatible] .fms-presentation-image-frame.frame-contain img{display:block;width:auto;height:auto;max-width:100%;max-height:17rem;object-fit:contain;object-position:center}[data-first-message-studio-compatible] .fms-presentation-image-frame:not(.frame-contain) img{width:100%;height:100%;object-fit:cover;object-position:center}[data-first-message-studio-compatible] .fms-presentation-copy{display:grid;align-content:center;gap:.42rem;padding:.75rem;border-left:3px solid ${project.appearance.accentColor};border-radius:${Math.max(3, Math.round(project.appearance.cornerRadius * .25))}px;background:color-mix(in srgb,${project.appearance.accentColor} 7%,transparent)}[data-first-message-studio-compatible] .fms-presentation-copy b{color:${project.appearance.accentColor};font-size:.7rem;letter-spacing:.06em}[data-first-message-studio-compatible] .fms-presentation-copy p{font-size:.84rem;line-height:1.6}${positionCss}${interactionCss}</style><div class="fms-presentations">${presentations}</div>`
}

function compileStage(project: FirstMessageStudioProject, stage: FirstMessageStudioProject['stages'][number], stageIndex: number): string {
    const stageVariable = compatibilityStageVariable(project)
    const speaker = stage.speaker ? `<b>${cbsValue(stage.speaker, project, true)}</b>` : ''
    const description = stage.optionPresentationEnabled
        ? compilePresentations(project, stage, stageIndex)
        : `<div class="fms-description">${speaker}<p>${cbsValue(stage.description, project, true)}</p></div>`
    return `{{#if {{equal::{{getvar::${stageVariable}}}::${stage.id}}}}}<section class="fms-stage fms-stage-${stageIndex}"><div class="fms-stage-heading"><small>${cbsValue(stage.tag, project, true)}</small><h2>${cbsValue(stage.title, project, true)}</h2></div>${description}<div class="fms-options">${compileOptions(project, stage)}</div></section>{{/if}}`
}

function compileProgress(project: FirstMessageStudioProject): string {
    const stageVariable = compatibilityStageVariable(project)
    return project.stages.map((stage, index) => {
        const condition = `{{equal::{{getvar::${stageVariable}}}::${stage.id}}}`
        return `{{#if ${condition}}}<span class="active">${index + 1}</span>{{/if}}{{#if {{notequal::{{getvar::${stageVariable}}}::${stage.id}}}}}<span>${index + 1}</span>{{/if}}`
    }).join('')
}

function compileCss(project: FirstMessageStudioProject): string {
    const a = project.appearance
    const custom = project.customCss
        .replace(/@import\s+[^;]+;?/gi, '')
        .replace(/@charset\s+[^;]+;?/gi, '')
        .replace(/<\/style/gi, '<\\/style')
        .replace(/expression\s*\(/gi, '')
        .replace(/:scope/g, '[data-first-message-studio-compatible]')
    return `<style>[data-first-message-studio-compatible]{box-sizing:border-box;width:min(34rem,100%);margin:1rem auto;overflow:hidden;border:1px solid ${a.accentColor};border-radius:${a.cornerRadius}px;color:${a.textColor};background:${a.backgroundColor};box-shadow:0 1.2rem 3.5rem rgba(0,0,0,.28);font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.4}[data-first-message-studio-compatible] *{box-sizing:border-box}[data-first-message-studio-compatible] h2,[data-first-message-studio-compatible] p{margin:0}[data-first-message-studio-compatible] .fms-window-header{display:flex;align-items:center;gap:1rem;padding:.85rem 1rem;border-bottom:1px solid color-mix(in srgb,${a.textColor} 12%,transparent);background:${a.surfaceColor}}[data-first-message-studio-compatible] .fms-window-header>strong{overflow:hidden;font-size:.88rem;text-overflow:ellipsis;white-space:nowrap}[data-first-message-studio-compatible] .fms-progress{display:flex;gap:.35rem;margin-left:auto}[data-first-message-studio-compatible] .fms-progress span{display:grid;width:1.45rem;height:1.45rem;place-items:center;border:1px solid color-mix(in srgb,${a.textColor} 16%,transparent);border-radius:999px;opacity:.65;font-size:.65rem;font-weight:800}[data-first-message-studio-compatible] .fms-progress span.active{border-color:${a.accentColor};color:${a.backgroundColor};background:${a.accentColor};opacity:1}[data-first-message-studio-compatible] .fms-window-body{min-height:18rem;padding:1rem;background:${a.surfaceColor}}[data-first-message-studio-compatible] .fms-stage-heading{display:grid;gap:.35rem}[data-first-message-studio-compatible] .fms-stage-heading>small{width:max-content;padding:.18rem .42rem;border-radius:.25rem;color:${a.backgroundColor};background:${a.accentColor};font-size:.62rem;font-weight:850;letter-spacing:.08em}[data-first-message-studio-compatible] .fms-stage-heading h2{font-size:1.2rem}[data-first-message-studio-compatible] .fms-description{margin:.8rem 0;padding:.75rem;border-left:3px solid ${a.accentColor};border-radius:.25rem;background:color-mix(in srgb,${a.accentColor} 8%,transparent)}[data-first-message-studio-compatible] .fms-description b{display:block;margin-bottom:.25rem;color:${a.accentColor};font-size:.68rem}[data-first-message-studio-compatible] .fms-description p{font-size:.82rem;line-height:1.55}[data-first-message-studio-compatible] .fms-options{display:grid;grid-template-columns:repeat(${a.optionColumns},minmax(0,1fr));gap:.5rem}[data-first-message-studio-compatible] .fms-options button{display:grid;width:100%;min-height:3rem;gap:.15rem;padding:.65rem .7rem;border:1px solid color-mix(in srgb,${a.textColor} 16%,transparent);border-radius:${Math.max(4, Math.round(a.cornerRadius / 3))}px;color:${a.textColor};background:color-mix(in srgb,${a.backgroundColor} 55%,${a.surfaceColor});text-align:left;font:inherit}[data-first-message-studio-compatible] button span,[data-first-message-studio-compatible] button small{opacity:.72}[data-first-message-studio-compatible] .fms-window-actions{display:flex;justify-content:flex-end;padding:.7rem 1rem;border-top:1px solid color-mix(in srgb,${a.textColor} 12%,transparent);background:${a.backgroundColor}}[data-first-message-studio-compatible] .fms-window-actions button{padding:.48rem .75rem;border:1px solid color-mix(in srgb,${a.textColor} 16%,transparent);border-radius:.35rem;color:${a.textColor};background:transparent;font:inherit}@media(max-width:34rem){[data-first-message-studio-compatible] .fms-options{grid-template-columns:1fr}}${custom}</style>`
}

function compileExtraHtml(project: FirstMessageStudioProject): string {
    return project.customHtml.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, '{{getvar::$1}}')
}

function combineCbs(name: 'and' | 'or', expressions: string[]): string {
    if (expressions.length === 0) return '0'
    return expressions.slice(1).reduce((combined, expression) => `{{${name}::${combined}::${expression}}}`, expressions[0])
}

function compileScenarioCondition(project: FirstMessageStudioProject, rule: FirstMessageStudioProject['scenarioRules'][number]): string {
    const groups = rule.groups.flatMap((group) => {
        const conditions = group.conditions.map((condition) => {
            const operation = condition.operator === 'not-equals' ? 'notequal' : 'equal'
            return `{{${operation}::{{getvar::${condition.variable}}}::${condition.value}}}`
        })
        return conditions.length > 0 ? [combineCbs('or', conditions)] : []
    })
    return groups.length === rule.groups.length && groups.length > 0 ? combineCbs('and', groups) : '0'
}

function compileCompletionMessage(project: FirstMessageStudioProject): string {
    const rules = project.scenarioRules.flatMap((rule) => {
        const condition = compileScenarioCondition(project, rule)
        return condition === '0' ? [] : [{ rule, condition }]
    })
    if (rules.length === 0) return project.fallbackMessage
    const previousConditions: string[] = []
    const scenarios = rules.map(({ rule, condition }) => {
        const firstMatchCondition = previousConditions.length === 0
            ? condition
            : combineCbs('and', [condition, ...previousConditions.map((previous) => `{{notequal::${previous}::1}}`)])
        previousConditions.push(condition)
        return `{{#if ${firstMatchCondition}}}${cbsValue(rule.message, project)}{{/if}}`
    }).join('')
    const anyScenario = combineCbs('or', rules.map(({ condition }) => condition))
    const fallback = `{{#if {{notequal::${anyScenario}::1}}}}${project.fallbackMessage}{{/if}}`
    return `${scenarios}${fallback}`
}

export function isFirstMessageStudioCompatibilityMessage(value: string): boolean {
    return value.includes(`<!-- ${PROJECT_TYPE} -->`)
}

export function compileFirstMessageStudioCompatibility(projectValue: FirstMessageStudioProject): FirstMessageStudioCompatibilityResult {
    const project = normalizeFirstMessageStudioProject(projectValue)
    const header = project.appearance.showHeader || project.appearance.showProgress
        ? `<header class="fms-window-header">${project.appearance.showHeader ? `<strong>${cbsValue(project.title, project, true)}</strong>` : ''}${project.appearance.showProgress ? `<div class="fms-progress">${compileProgress(project)}</div>` : ''}</header>`
        : ''
    const actions = project.appearance.showNavigation
        ? `<footer class="fms-window-actions"><button type="button" risu-trigger="${TRIGGER_PREFIX}reset">${cbsValue({ ko: '처음부터', ja: '最初から', en: 'Reset' }, project, true)}</button></footer>`
        : ''
    const selector = `${compileCss(project)}<div data-first-message-studio-compatible>${header}<div class="fms-window-body">${compileExtraHtml(project)}${project.stages.map((stage, index) => compileStage(project, stage, index)).join('')}</div>${actions}</div>`
    const firstMessage = `<!-- ${PROJECT_TYPE} -->\n{{#if {{notequal::{{getvar::${project.completionVariable}}}::1}}}}${selector}{{/if}}\n{{#if {{equal::{{getvar::${project.completionVariable}}}::1}}}}${compileCompletionMessage(project)}{{/if}}`
    const defaults = [
        `${project.completionVariable}=0`,
        `${compatibilityStageVariable(project)}=${project.startStageId}`,
        `${project.localization.variable}=${project.localization.languages.find((language) => language.id === project.localization.defaultLanguage)?.value ?? project.localization.languages[0]?.value ?? ''}`,
        ...project.variables
            .filter((variable) => variable.name !== project.localization.variable)
            .map((variable) => `${variable.name}=${variable.defaultValue}`),
    ]
    return {
        firstMessage,
        triggers: [
            ...project.stages.flatMap((stage) => stage.options.map((option) => compileTrigger(project, stage.id, option))),
            {
                comment: `${TRIGGER_PREFIX}reset`,
                type: 'manual',
                conditions: [],
                effect: [
                    { type: 'setvar', operator: '=', var: project.completionVariable, value: '0' },
                    { type: 'setvar', operator: '=', var: compatibilityStageVariable(project), value: project.startStageId },
                    { type: 'setvar', operator: '=', var: project.localization.variable, value: project.localization.languages.find((language) => language.id === project.localization.defaultLanguage)?.value ?? project.localization.languages[0]?.value ?? '' },
                    ...project.variables
                        .filter((variable) => variable.name !== project.localization.variable)
                        .map((variable) => ({ type: 'setvar' as const, operator: '=' as const, var: variable.name, value: variable.defaultValue })),
                ],
            },
        ],
        defaultVariables: defaults.join('\n'),
    }
}

export function mergeFirstMessageStudioTriggers(existing: triggerscript[] = [], generated: triggerscript[]): triggerscript[] {
    return [...existing.filter((trigger) => !trigger.comment.startsWith(TRIGGER_PREFIX)), ...generated]
}

export function mergeFirstMessageStudioDefaultVariables(existing: string = '', generated: string): string {
    const managed = new RegExp(`${VARIABLES_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${VARIABLES_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g')
    const preserved = existing.replace(managed, '').trim()
    if (!generated.trim()) return preserved
    const block = `${VARIABLES_BEGIN}\n${generated.trim()}\n${VARIABLES_END}`
    return preserved ? `${preserved}\n\n${block}` : block
}

export function exportFirstMessageStudioProject(project: FirstMessageStudioProject): string {
    return JSON.stringify({ type: PROJECT_TYPE, version: 1, project: normalizeFirstMessageStudioProject(project) }, null, 2)
}

export function importFirstMessageStudioProject(source: string): FirstMessageStudioProject {
    let envelope: unknown
    try {
        envelope = JSON.parse(source)
    }
    catch {
        throw new Error('올바른 스튜디오 JSON 파일이 아닙니다.')
    }
    if (!envelope || typeof envelope !== 'object' || (envelope as Record<string, unknown>).type !== PROJECT_TYPE) {
        throw new Error('퍼스트 메시지 스튜디오 프로젝트 파일이 아닙니다.')
    }
    if ((envelope as Record<string, unknown>).version !== 1) throw new Error('지원하지 않는 스튜디오 프로젝트 버전입니다.')
    return normalizeFirstMessageStudioProject((envelope as Record<string, unknown>).project)
}
