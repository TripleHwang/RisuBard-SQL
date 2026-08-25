import { describe, expect, it } from 'vitest'
import {
    applyStudioOption,
    backStudioRuntime,
    createBlankStudioProject,
    createStudioRuntime,
    localizeStudioText,
    matchesFirstMessageStudioScenario,
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

    it('normalizes opt-in hover presentations without treating asset names as local paths', () => {
        const project = normalizeFirstMessageStudioProject({
            enabled: true,
            stages: [{
                id: 'persona',
                title: 'Persona',
                description: 'Choose.',
                optionPresentationEnabled: true,
                options: [
                    { id: 'farmer', label: 'Farmer', effects: [], presentation: {
                        speaker: { ko: '농부' },
                        description: { ko: '오늘도 밭에서 이삭을 줍습니다.' },
                        imageEnabled: true,
                        imageFrame: 'square',
                        imagePositionX: 120,
                        imagePositionY: -10,
                        imageAssetName: '  farmer.webp  ',
                    } },
                    { id: 'warrior', label: 'Warrior', effects: [], presentation: {
                        description: 'A sword inherited from your father.',
                        imageEnabled: false,
                        imageFrame: 'unsupported',
                        imagePositionX: 'invalid',
                        imageAssetName: '   ',
                    } },
                ],
            }],
        })

        expect(project.stages[0].optionPresentationEnabled).toBe(true)
        expect(project.stages[0].options[0].presentation).toMatchObject({
            speaker: { ko: '농부' },
            description: { ko: '오늘도 밭에서 이삭을 줍습니다.' },
            imageEnabled: true,
            imageFrame: 'square',
            imagePositionX: 100,
            imagePositionY: 0,
            imageAssetName: 'farmer.webp',
        })
        expect(project.stages[0].options[1].presentation?.imageFrame).toBe('contain')
        expect(project.stages[0].options[1].presentation).toMatchObject({ imagePositionX: 50, imagePositionY: 50 })
        expect(project.stages[0].options[1].presentation?.imageAssetName).toBeUndefined()
    })

    it('normalizes scenario rules and matches AND groups containing OR conditions', () => {
        const project = normalizeFirstMessageStudioProject({
            enabled: true,
            stages: [{ id: 'welcome', title: 'Welcome', description: '', options: [] }],
            scenarioRules: [{
                id: 'route-intro',
                label: 'Route introduction',
                message: { ko: '선택된 도입부', en: 'Selected intro' },
                groups: [
                    { id: 'start', conditions: [{ variable: '$start', operator: 'equals', value: '2' }] },
                    { id: 'role', conditions: [
                        { variable: 'protagonist', operator: 'equals', value: 'none' },
                        { variable: 'role', operator: 'equals', value: 'leader' },
                    ] },
                    { id: 'mode', conditions: [{ variable: 'mode', operator: 'broken', value: 'canon' }] },
                ],
            }],
        } as any)

        expect(project.scenarioRules[0]).toMatchObject({
            id: 'route-intro',
            label: 'Route introduction',
            message: { ko: '선택된 도입부', en: 'Selected intro' },
            groups: [
                { id: 'start', conditions: [{ variable: 'start', operator: 'equals', value: '2' }] },
                { id: 'role' },
                { id: 'mode', conditions: [{ variable: 'mode', operator: 'equals', value: 'canon' }] },
            ],
        })
        expect(matchesFirstMessageStudioScenario(project.scenarioRules[0], {
            start: '2', protagonist: 'yes', role: 'leader', mode: 'canon',
        })).toBe(true)
        expect(matchesFirstMessageStudioScenario(project.scenarioRules[0], {
            start: '2', protagonist: 'yes', role: 'guest', mode: 'canon',
        })).toBe(false)
        project.scenarioRules[0].groups[2].conditions[0].operator = 'not-equals'
        expect(matchesFirstMessageStudioScenario(project.scenarioRules[0], {
            start: '2', protagonist: 'none', role: 'guest', mode: 'custom',
        })).toBe(true)
    })
})
