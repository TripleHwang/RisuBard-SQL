import { describe, expect, it } from 'vitest'
import {
    applyStudioOption,
    createBlankStudioProject,
    createScopedStudioCss,
    createStudioRuntime,
    interpolateStudioTemplate,
    normalizeFirstMessageStudioProject,
    resetStudioRuntime,
} from './firstMessageStudio'

describe('generic first message studio', () => {
    it('starts from a neutral project with only reusable window controls', () => {
        const project = createBlankStudioProject()

        expect(project).toMatchObject({
            enabled: true,
            title: 'FIRST MESSAGE',
            variables: [],
            customCss: '',
            customHtml: '',
            appearance: {
                preset: 'minimal',
                showHeader: true,
                showProgress: true,
                showNavigation: true,
            },
        })
        expect(project.appearance).not.toHaveProperty('showStatus')
        expect(project.appearance).not.toHaveProperty('showEffects')
        expect(project.stages[0]).not.toHaveProperty('channel')
    })

    it('normalizes registered variables and their selectable values', () => {
        const project = normalizeFirstMessageStudioProject({
            variables: [{
                name: '$route',
                label: 'Route',
                defaultValue: 'calm',
                choices: [
                    { label: 'Calm', value: 'calm' },
                    { label: 'Bold', value: 'bold' },
                ],
            }],
            stages: [{ id: 'start', title: 'Start', options: [] }],
        })

        expect(project.variables).toEqual([{
            name: 'route',
            label: 'Route',
            defaultValue: 'calm',
            choices: [
                { label: 'Calm', value: 'calm' },
                { label: 'Bold', value: 'bold' },
            ],
        }])
        expect(createStudioRuntime(project).variables.route).toBe('calm')
    })

    it('applies a registered variable choice and resets it to its declared default', () => {
        const project = normalizeFirstMessageStudioProject({
            enabled: true,
            completionVariable: 'done',
            variables: [{ name: 'route', label: 'Route', defaultValue: 'calm', choices: [] }],
            startStageId: 'start',
            stages: [{
                id: 'start', title: 'Start', description: '', options: [{
                    id: 'bold', label: 'Bold', effects: [{ variable: 'route', value: 'bold' }], completes: true,
                }],
            }],
        })
        const runtime = createStudioRuntime(project)
        const applied = applyStudioOption(project, runtime, 'bold').runtime

        expect(applied.variables).toMatchObject({ route: 'bold', done: '1' })
        expect(resetStudioRuntime(project, applied).variables).toMatchObject({ route: 'calm', done: '0' })
    })

    it('keeps advanced CSS and HTML portable while scoping CSS to one runtime', () => {
        const project = normalizeFirstMessageStudioProject({
            customCss: '.studio-extra { color: red; }\n@import "https://invalid.example/style.css";',
            customHtml: '<div class="studio-extra">{{route}}</div>',
            stages: [{ id: 'start', title: 'Start', options: [] }],
        })

        expect(project.customHtml).toContain('{{route}}')
        expect(interpolateStudioTemplate(project.customHtml, { route: '<bold>' }))
            .toContain('&lt;bold&gt;')
        const css = createScopedStudioCss('studio-scope', project.customCss)
        expect(css).toContain('@scope (#studio-scope)')
        expect(css).toContain('.studio-extra')
        expect(css).not.toContain('@import')
    })
})
