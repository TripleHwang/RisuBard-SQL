import { describe, expect, it } from 'vitest'
import { createBlankStudioProject } from './firstMessageStudio'
import {
    compileFirstMessageStudioCompatibility,
    exportFirstMessageStudioProject,
    importFirstMessageStudioProject,
    mergeFirstMessageStudioDefaultVariables,
    mergeFirstMessageStudioTriggers,
} from './firstMessageStudioSharing'

function sharingFixture() {
    const project = createBlankStudioProject()
    project.fallbackMessage = 'The story begins.'
    project.completionVariable = 'setup_done'
    project.stageVariable = 'setup_stage'
    project.localization = {
        variable: 'message_language',
        defaultLanguage: 'ko',
        languages: [
            { id: 'ko', label: '한국어', value: 'kr' },
            { id: 'en', label: 'English', value: 'en' },
        ],
    }
    project.variables = [{ name: 'route', label: 'Route', defaultValue: 'calm', choices: [] }]
    project.stages[0].options = [{
        id: 'continue',
        label: { ko: '계속', en: 'Continue' },
        description: { ko: '이야기를 시작합니다.', en: 'Start the story.' },
        effects: [{ variable: 'route', value: { ko: '차분', en: 'calm' } }],
        input: {
            variable: 'display_name',
            displayVariable: 'name_shown',
            label: { ko: '이름', en: 'Name' },
            required: true,
        },
        completes: true,
    }]
    return project
}

describe('First Message Studio sharing', () => {
    it('round-trips a versioned portable project including its completion message', () => {
        const source = sharingFixture()
        const json = exportFirstMessageStudioProject(source)
        const envelope = JSON.parse(json)

        expect(envelope).toMatchObject({ type: 'risubard-first-message-studio', version: 1 })
        expect(importFirstMessageStudioProject(json)).toMatchObject({
            fallbackMessage: 'The story begins.',
            compatibilityEnabled: true,
            stages: [{ id: 'welcome' }],
        })
    })

    it('rejects unrelated or future project files', () => {
        expect(() => importFirstMessageStudioProject('{}')).toThrow(/스튜디오/)
        expect(() => importFirstMessageStudioProject(JSON.stringify({
            type: 'risubard-first-message-studio', version: 2, project: {},
        }))).toThrow(/버전/)
    })

    it('compiles a standard first message and Risu trigger scripts', () => {
        const result = compileFirstMessageStudioCompatibility(sharingFixture())

        expect(result.firstMessage).toContain('data-first-message-studio-compatible')
        expect(result.firstMessage).toContain('The story begins.')
        expect(result.firstMessage).toContain('{{getvar::setup_done}}')
        expect(result.firstMessage).toContain('risu-trigger="[First Message Studio] welcome/continue"')
        expect(result.defaultVariables).toContain('setup_stage=welcome')
        expect(result.defaultVariables).toContain('message_language=kr')

        expect(result.firstMessage).toContain('class="fms-window-header"')
        expect(result.firstMessage).toContain('class="fms-window-body"')
        expect(result.firstMessage).toContain('width:min(34rem,100%)')
        expect(result.firstMessage).toContain('risu-trigger="[First Message Studio] reset"')

        expect(result.triggers).toHaveLength(2)
        expect(result.triggers[0]).toMatchObject({
            comment: '[First Message Studio] welcome/continue',
            type: 'manual',
            conditions: [],
        })
        expect(result.triggers[0].effect).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'v2GetAlertInput', outputVar: 'display_name' }),
            expect.objectContaining({ type: 'setvar', var: 'name_shown', value: '{{getvar::display_name}}' }),
            expect.objectContaining({ type: 'setvar', var: 'setup_done', value: '1' }),
        ]))
        const route = result.triggers[0].effect.find((effect: any) => effect.type === 'setvar' && effect.var === 'route') as any
        expect(route.value).toContain('{{getvar::message_language}}')
        expect(route.value).toContain('calm')
        expect(result.triggers[1]).toMatchObject({
            comment: '[First Message Studio] reset',
            type: 'manual',
            effect: expect.arrayContaining([
                expect.objectContaining({ type: 'setvar', var: 'setup_done', value: '0' }),
                expect.objectContaining({ type: 'setvar', var: 'setup_stage', value: 'welcome' }),
            ]),
        })
    })

    it('replaces only previously generated triggers and variable blocks', () => {
        const generated = compileFirstMessageStudioCompatibility(sharingFixture())
        const triggers = mergeFirstMessageStudioTriggers([
            { comment: 'User trigger', type: 'manual', conditions: [], effect: [] },
            { comment: '[First Message Studio] old/choice', type: 'manual', conditions: [], effect: [] },
        ] as any, generated.triggers)
        expect(triggers.map((trigger) => trigger.comment)).toEqual([
            'User trigger',
            '[First Message Studio] welcome/continue',
            '[First Message Studio] reset',
        ])

        const once = mergeFirstMessageStudioDefaultVariables('user_value=keep', generated.defaultVariables)
        const twice = mergeFirstMessageStudioDefaultVariables(once, 'setup_stage=changed')
        expect(twice).toContain('user_value=keep')
        expect(twice).toContain('setup_stage=changed')
        expect(twice.match(/First Message Studio:begin/g)).toHaveLength(1)
    })

    it('emits the localization variable only once when it is also registered as a project variable', () => {
        const project = sharingFixture()
        project.variables.push({ name: 'message_language', label: 'Language', defaultValue: 'wrong', choices: [] })

        const result = compileFirstMessageStudioCompatibility(project)

        expect(result.defaultVariables.match(/^message_language=/gm)).toHaveLength(1)
        expect(result.defaultVariables).toContain('message_language=kr')
        const reset = result.triggers.find((trigger) => trigger.comment === '[First Message Studio] reset')!
        expect(reset.effect.filter((effect: any) => effect.type === 'setvar' && effect.var === 'message_language')).toHaveLength(1)
    })

    it('compiles scenario groups into AND/OR CBS branches with a guarded fallback', () => {
        const project = sharingFixture()
        project.scenarioRules = [{
            id: 'second-day-lead',
            label: 'Second day lead',
            message: { ko: '둘째 날의 리더 도입', en: 'Second-day leader intro' },
            groups: [
                { id: 'start', conditions: [{ variable: 'start', operator: 'equals', value: '2' }] },
                { id: 'role', conditions: [
                    { variable: 'protagonist', operator: 'equals', value: 'none' },
                    { variable: 'role', operator: 'not-equals', value: 'guest' },
                ] },
            ],
        }]

        const result = compileFirstMessageStudioCompatibility(project)

        expect(result.firstMessage).toContain('{{and::')
        expect(result.firstMessage).toContain('{{or::')
        expect(result.firstMessage).toContain('{{equal::{{getvar::start}}::2}}')
        expect(result.firstMessage).toContain('{{notequal::{{getvar::role}}::guest}}')
        expect(result.firstMessage).toContain('둘째 날의 리더 도입')
        expect(result.firstMessage).toContain('Second-day leader intro')
        expect(result.firstMessage).toMatch(/notequal::\{\{and::[\s\S]+The story begins\./)
    })

    it('uses the first matching scenario when ordered rules overlap', () => {
        const project = sharingFixture()
        project.scenarioRules = [
            { id: 'specific', label: 'Specific', message: 'Specific intro', groups: [{ id: 'g1', conditions: [{ variable: 'route', operator: 'equals', value: 'calm' }] }] },
            { id: 'general', label: 'General', message: 'General intro', groups: [{ id: 'g2', conditions: [{ variable: 'route', operator: 'not-equals', value: 'chaos' }] }] },
        ]

        const result = compileFirstMessageStudioCompatibility(project)

        expect(result.firstMessage).toContain('{{and::{{notequal::{{getvar::route}}::chaos}}::{{notequal::{{equal::{{getvar::route}}::calm}}::1}}}}')
        expect(result.firstMessage.indexOf('Specific intro')).toBeLessThan(result.firstMessage.indexOf('General intro'))
    })

    it('compiles option hover presentations with localized copy and card asset names', () => {
        const project = sharingFixture()
        project.stages[0].optionPresentationEnabled = true
        project.stages[0].options[0].presentation = {
            speaker: { ko: '농부', en: 'Farmer' },
            description: { ko: '오늘도 밭에서 이삭을 줍습니다.', en: 'You gather grain in the field.' },
            imageEnabled: true,
            imageFrame: 'square',
            imagePositionX: 35,
            imagePositionY: 65,
            imageAssetName: 'farmer.webp',
        }
        project.stages[0].options.push({
            id: 'warrior', label: { ko: '전사', en: 'Warrior' }, effects: [], presentation: {
                speaker: { ko: '전사', en: 'Warrior' },
                description: { ko: '당신이 믿는 것은 물려받은 장검뿐입니다.', en: 'You trust your inherited sword.' },
                imageEnabled: false,
                imageFrame: 'contain',
                imagePositionX: 50,
                imagePositionY: 50,
            },
        })

        const result = compileFirstMessageStudioCompatibility(project)

        expect(result.firstMessage).toContain('class="fms-presentations"')
        expect(result.firstMessage).toContain('class="fms-presentation with-image"')
        expect(result.firstMessage).toContain('class="fms-presentation-image-frame frame-square fms-presentation-position-0-0"')
        expect(result.firstMessage).toContain('</div><div class="fms-presentation-copy">')
        expect(result.firstMessage).toContain('.fms-presentation-position-0-0 img{object-position:35% 65%!important}')
        expect(result.firstMessage).toContain('style="width:100%!important;height:100%!important;max-width:none!important;max-height:none!important;margin:0!important;object-fit:cover!important;object-position:35% 65%!important"')
        expect(result.firstMessage).toContain('src="{{raw::farmer.webp}}"')
        expect(result.firstMessage).toContain('오늘도 밭에서 이삭을 줍습니다.')
        expect(result.firstMessage).toContain('You trust your inherited sword.')
        expect(result.firstMessage).toContain(':has(.fms-option:nth-child(2):hover)')
        expect(result.firstMessage).toContain(':has(.fms-option:nth-child(2):focus-visible)')
    })
})
