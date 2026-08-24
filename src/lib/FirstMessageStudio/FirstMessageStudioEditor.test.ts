// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import type { character } from 'src/ts/storage/database.svelte'
import { createBlankStudioProject } from 'src/ts/firstMessageStudio'
import FirstMessageStudioEditor from './FirstMessageStudioEditor.svelte'

let mounted: ReturnType<typeof mount> | undefined

function blankCharacter(): character {
    return { name: 'Test character', firstMessage: 'Hello' } as character
}

describe('FirstMessageStudioEditor', () => {
    beforeEach(() => {
        localStorage.setItem('risu-lang', 'ko')
    })

    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
        localStorage.clear()
    })

    test('opens every character with the neutral minimum builder', () => {
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character: blankCharacter(), onClose: vi.fn() },
        })

        expect(document.body.textContent).toContain('퍼스트 메시지 스튜디오')
        expect(document.body.textContent).toContain('화면과 선택지')
        expect(document.body.textContent).toContain('변수')
        expect(document.body.textContent).toContain('창 디자인')
        expect(document.body.textContent).toContain('고급 코드')
        expect(document.body.querySelectorAll('[data-studio-editor-stage]')).toHaveLength(1)
        expect(document.body.textContent).toContain('첫 화면')
    })

    test('registers a variable and its selectable values', async () => {
        const character = blankCharacter()
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-variables-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-add-variable]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-studio-add-variable]')!.click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-variable]')).toHaveLength(1))

        const name = document.body.querySelector<HTMLInputElement>('[data-studio-variable-name]')!
        name.value = 'route'
        name.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-studio-add-variable-choice]')!.click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-variable-choice]')).toHaveLength(1))

        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()
        await vi.waitFor(() => expect(character.firstMessageStudio?.variables[0].name).toBe('route'))
        expect(character.firstMessageStudio?.variables[0].choices).toHaveLength(1)
    })

    test('renames variable references already connected to choices', async () => {
        const character = blankCharacter()
        const project = createBlankStudioProject()
        project.variables = [{ name: 'route', label: 'Route', defaultValue: '', choices: [] }]
        project.stages[0].options = [{ id: 'calm', label: 'Calm', effects: [{ variable: 'route', value: 'calm' }] }]
        character.firstMessageStudio = project
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-variables-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-variable-name]')).not.toBeNull())
        const name = document.body.querySelector<HTMLInputElement>('[data-studio-variable-name]')!
        name.value = 'path'
        name.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()

        await vi.waitFor(() => expect(character.firstMessageStudio?.variables[0].name).toBe('path'))
        expect(character.firstMessageStudio?.stages[0].options[0].effects[0].variable).toBe('path')
    })

    test('edits screens and choices with no-code controls', async () => {
        const character = blankCharacter()
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        const title = document.body.querySelector<HTMLInputElement>('[data-studio-stage-title]')!
        title.value = 'Choose a route'
        title.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-studio-add-option]')!.click()
        document.body.querySelector<HTMLButtonElement>('[data-studio-add-stage]')!.click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-editor-stage]')).toHaveLength(2))

        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()
        await vi.waitFor(() => expect(character.firstMessageStudio).toBeDefined())
        expect(character.firstMessageStudio?.stages[0].title).toMatchObject({ ko: 'Choose a route' })
        expect(character.firstMessageStudio?.stages[0].options).toHaveLength(1)
    })

    test('uses the global app language without a separate language row', async () => {
        localStorage.setItem('risu-lang', 'en')
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character: blankCharacter(), onClose: vi.fn() },
        })

        expect(document.body.querySelector('.locale-tabs')).toBeNull()
        expect(document.body.querySelector<HTMLInputElement>('[data-studio-stage-title]')?.value).toBe('First screen')
    })

    test('keeps the live preview on its current screen while that screen is edited', async () => {
        const character = blankCharacter()
        const project = createBlankStudioProject()
        project.stages[0].options = [{
            id: 'next',
            label: { ko: '다음', ja: '次へ', en: 'Next' },
            effects: [],
            nextStageId: 'second',
        }]
        project.stages.push({
            id: 'second',
            tag: { ko: '둘', ja: '二', en: 'TWO' },
            title: { ko: '두 번째 화면', ja: '二番目', en: 'Second screen' },
            description: { ko: '편집할 화면', ja: '編集画面', en: 'Edit this screen' },
            options: [],
        })
        character.firstMessageStudio = project
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-option="next"]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-stage="second"]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-studio-editor-stage="second"]')!.click()
        const title = document.body.querySelector<HTMLInputElement>('[data-studio-stage-title]')!
        title.value = '수정된 두 번째 화면'
        title.dispatchEvent(new Event('input', { bubbles: true }))

        await vi.waitFor(() => {
            expect(document.body.querySelector('[data-studio-stage="second"]')).not.toBeNull()
            expect(document.body.textContent).toContain('수정된 두 번째 화면')
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-remove-stage]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-stage="welcome"]')).not.toBeNull())
    })

    test('opens project settings from every editor tab', async () => {
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character: blankCharacter(), onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-variables-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-add-variable]')).not.toBeNull())
        const projectSettings = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
            .find((button) => button.textContent?.trim() === '프로젝트 설정')!
        projectSettings.click()

        await vi.waitFor(() => expect(document.body.textContent).toContain('완료 변수'))
        expect(document.body.textContent).toContain('현재 화면 변수')
    })

    test('saves generic colors, shape, CSS, and extra HTML', async () => {
        const character = blankCharacter()
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-design-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-accent-color]')).not.toBeNull())
        const accent = document.body.querySelector<HTMLInputElement>('[data-studio-accent-color]')!
        accent.value = '#65d9ff'
        accent.dispatchEvent(new Event('input', { bubbles: true }))

        document.body.querySelector<HTMLButtonElement>('[data-studio-code-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-custom-css]')).not.toBeNull())
        const css = document.body.querySelector<HTMLTextAreaElement>('[data-studio-custom-css]')!
        css.value = ':scope { border-width: 2px; }'
        css.dispatchEvent(new Event('input', { bubbles: true }))
        const html = document.body.querySelector<HTMLTextAreaElement>('[data-studio-custom-html]')!
        html.value = '<div>{{route}}</div>'
        html.dispatchEvent(new Event('input', { bubbles: true }))

        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()
        await vi.waitFor(() => expect(character.firstMessageStudio?.customCss).toContain('border-width'))
        expect(character.firstMessageStudio).toMatchObject({
            customHtml: '<div>{{route}}</div>',
            appearance: { accentColor: '#65d9ff' },
        })
    })
})
