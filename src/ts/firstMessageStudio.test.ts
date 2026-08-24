import { describe, expect, it } from 'vitest'
import {
    applyStudioOption,
    backStudioRuntime,
    createBlankStudioProject,
    createStudioRuntime,
    localizeStudioText,
    normalizeFirstMessageStudioProject,
    resetStudioRuntime,
    resolveStudioLocale,
    resolveStudioProjectLocale,
    setStudioTextLanguage,
    setStudioInput,
} from './firstMessageStudio'

function projectFixture() {
    return normalizeFirstMessageStudioProject({
        enabled: true,
        title: 'Character setup',
        completionVariable: 'setup_done',
        stageVariable: 'setup_stage',
        variables: [{ name: 'route', label: 'Route', defaultValue: 'calm', choices: [
            { label: 'Calm', value: 'calm' },
            { label: 'Bold', value: 'bold' },
        ] }],
        startStageId: 'route',
        stages: [
            {
                id: 'route',
                tag: 'STEP',
                title: { ko: '방향', ja: '方向', en: 'Route' },
                description: 'Choose a route.',
                options: [
                    { id: 'calm', label: 'Calm', effects: [{ variable: 'route', value: 'calm' }], nextStageId: 'name' },
                    { id: 'bold', label: 'Bold', effects: [{ variable: 'route', value: 'bold' }], nextStageId: 'name' },
                ],
            },
            {
                id: 'name',
                tag: 'STEP',
                title: 'Name',
                description: 'Write a name.',
                options: [{
                    id: 'finish',
                    label: 'Finish',
                    effects: [],
                    input: { variable: 'display_name', label: 'Name', required: true },
                    completes: true,
                }],
            },
        ],
    })
}

describe('first message studio engine', () => {
    it('creates a neutral editable project', () => {
        const project = createBlankStudioProject()
        expect(project.enabled).toBe(true)
        expect(project.stages).toHaveLength(1)
        expect(project.variables).toEqual([])
        expect(project.appearance).toMatchObject({ preset: 'minimal', showHeader: true, showProgress: true, showNavigation: true })
    })

    it('localizes reusable text values', () => {
        expect(localizeStudioText({ ko: '한국어', ja: '日本語', en: 'English' }, 'ja')).toBe('日本語')
        expect(localizeStudioText('Same', 'en')).toBe('Same')
        expect(resolveStudioLocale({}, 'en')).toBe('en')
        expect(resolveStudioLocale({ cv_lang: '2' }, 'en')).toBe('ja')
    })

    it('preserves an arbitrary project language list and its translation keys', () => {
        const project = normalizeFirstMessageStudioProject({
            enabled: true,
            localization: {
                variable: 'message_language',
                defaultLanguage: 'ko-KR',
                languages: [
                    { id: 'ko-KR', label: '한국어', value: 'kr' },
                    { id: 'fr', label: 'Français', value: 'français' },
                ],
            },
            title: { 'ko-KR': '설정', fr: 'Configuration' },
            stages: [{
                id: 'welcome',
                title: { 'ko-KR': '환영', fr: 'Bienvenue' },
                description: '',
                options: [],
            }],
        } as any)

        expect(project.localization).toEqual({
            variable: 'message_language',
            defaultLanguage: 'ko-KR',
            languages: [
                { id: 'ko-KR', label: '한국어', value: 'kr' },
                { id: 'fr', label: 'Français', value: 'français' },
            ],
        })
        expect(localizeStudioText(project.title, 'fr')).toBe('Configuration')
        expect(localizeStudioText(project.stages[0].title, 'fr')).toBe('Bienvenue')
        expect(resolveStudioProjectLocale(project, { message_language: 'français' }, 'ko-KR')).toBe('fr')
        expect(setStudioTextLanguage('공통', 'fr', 'Commun', project.localization.languages)).toEqual({
            'ko-KR': '공통',
            fr: 'Commun',
        })
    })

    it('applies variable assignments and follows screen branches', () => {
        const project = projectFixture()
        const initial = createStudioRuntime(project)
        const selected = applyStudioOption(project, initial, 'bold').runtime

        expect(initial.variables).toMatchObject({ route: 'calm', setup_done: '0', setup_stage: 'route' })
        expect(selected.stageId).toBe('name')
        expect(selected.variables).toMatchObject({ route: 'bold', setup_stage: 'name' })
    })

    it('requires direct input and completes after it is supplied', () => {
        const project = projectFixture()
        let runtime = applyStudioOption(project, createStudioRuntime(project), 'calm').runtime
        expect(applyStudioOption(project, runtime, 'finish').error).toBe('required-input')

        runtime = setStudioInput(runtime, 'display_name', 'Ari')
        runtime = applyStudioOption(project, runtime, 'finish').runtime
        expect(runtime.completed).toBe(true)
        expect(runtime.variables).toMatchObject({ display_name: 'Ari', setup_done: '1' })
    })

    it('supports back and reset without mutating caller values', () => {
        const project = projectFixture()
        const source = { keep: 'yes' }
        const initial = createStudioRuntime(project, source)
        const selected = applyStudioOption(project, initial, 'bold').runtime
        const backed = backStudioRuntime(selected)
        const reset = resetStudioRuntime(project, selected)

        expect(backed.stageId).toBe('route')
        expect(reset.stageId).toBe('route')
        expect(reset.variables).toMatchObject({ keep: 'yes', route: 'calm', setup_done: '0', setup_stage: 'route' })
        expect(source).toEqual({ keep: 'yes' })
    })

    it('normalizes imported values into a usable generic project', () => {
        const project = normalizeFirstMessageStudioProject({
            enabled: 'yes',
            completionVariable: '$done',
            startStageId: 'missing',
            stages: [{ id: '', title: 'Only', options: [] }],
            appearance: { preset: 'glass', optionColumns: 8, cornerRadius: 99 },
        })

        expect(project.version).toBe(1)
        expect(project.enabled).toBe(true)
        expect(project.completionVariable).toBe('done')
        expect(project.startStageId).toBe(project.stages[0].id)
        expect(project.appearance).toMatchObject({ preset: 'glass', optionColumns: 3, cornerRadius: 32 })
    })
})
