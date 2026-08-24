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
        return `<button type="button" risu-trigger="${escapeHtml(triggerName(stage.id, option.id))}"><strong>${cbsValue(option.label, project, true)}</strong>${description}${badge}</button>`
    }).join('')
}

function compileStage(project: FirstMessageStudioProject, stage: FirstMessageStudioProject['stages'][number]): string {
    const stageVariable = compatibilityStageVariable(project)
    const speaker = stage.speaker ? `<b>${cbsValue(stage.speaker, project, true)}</b>` : ''
    return `{{#if {{equal::{{getvar::${stageVariable}}}::${stage.id}}}}}<section class="fms-stage"><div class="fms-stage-heading"><small>${cbsValue(stage.tag, project, true)}</small><h2>${cbsValue(stage.title, project, true)}</h2></div><div class="fms-description">${speaker}<p>${cbsValue(stage.description, project, true)}</p></div><div class="fms-options">${compileOptions(project, stage)}</div></section>{{/if}}`
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

export function compileFirstMessageStudioCompatibility(projectValue: FirstMessageStudioProject): FirstMessageStudioCompatibilityResult {
    const project = normalizeFirstMessageStudioProject(projectValue)
    const header = project.appearance.showHeader || project.appearance.showProgress
        ? `<header class="fms-window-header">${project.appearance.showHeader ? `<strong>${cbsValue(project.title, project, true)}</strong>` : ''}${project.appearance.showProgress ? `<div class="fms-progress">${compileProgress(project)}</div>` : ''}</header>`
        : ''
    const actions = project.appearance.showNavigation
        ? `<footer class="fms-window-actions"><button type="button" risu-trigger="${TRIGGER_PREFIX}reset">${cbsValue({ ko: '처음부터', ja: '最初から', en: 'Reset' }, project, true)}</button></footer>`
        : ''
    const selector = `${compileCss(project)}<div data-first-message-studio-compatible>${header}<div class="fms-window-body">${compileExtraHtml(project)}${project.stages.map((stage) => compileStage(project, stage)).join('')}</div>${actions}</div>`
    const firstMessage = `<!-- ${PROJECT_TYPE} -->\n{{#if {{notequal::{{getvar::${project.completionVariable}}}::1}}}}${selector}{{/if}}\n{{#if {{equal::{{getvar::${project.completionVariable}}}::1}}}}${project.fallbackMessage}{{/if}}`
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
