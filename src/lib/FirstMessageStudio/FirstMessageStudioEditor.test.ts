// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import type { character } from 'src/ts/storage/database.svelte'
import { createBlankStudioProject } from 'src/ts/firstMessageStudio'
import FirstMessageStudioEditor from './FirstMessageStudioEditor.svelte'

const requestChatData = vi.hoisted(() => vi.fn())
const downloadFile = vi.hoisted(() => vi.fn())
const selectFileByDom = vi.hoisted(() => vi.fn())
vi.mock('src/ts/process/request/request', () => ({ requestChatData }))
vi.mock('src/ts/globalApi.svelte', () => ({ downloadFile }))
vi.mock('src/ts/util', () => ({ selectFileByDom }))

let mounted: ReturnType<typeof mount> | undefined

function blankCharacter(): character {
    return { name: 'Test character', firstMessage: 'Hello' } as character
}

describe('FirstMessageStudioEditor', () => {
    beforeEach(() => {
        localStorage.setItem('risu-lang', 'ko')
        requestChatData.mockReset()
        downloadFile.mockReset()
        selectFileByDom.mockReset()
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
        expect(document.body.textContent).not.toContain('FIRST MESSAGE BUILDER')
        expect(document.body.querySelector('[data-studio-title-row]')?.textContent).toContain('변수와 선택지를 연결하고')
        expect(document.body.querySelector<HTMLLabelElement>('[data-studio-enabled-toggle]')?.textContent?.replace(/\s/g, '')).toBe('스튜디오사용')
        expect(document.body.textContent).toContain('언어')
        expect(document.body.textContent).toContain('변수')
        expect(document.body.textContent).toContain('창 디자인')
        expect(document.body.textContent).toContain('고급 코드')
        expect(document.body.textContent).toContain('공유')
        expect(document.body.querySelectorAll('[data-studio-editor-stage]')).toHaveLength(1)
        expect(document.body.textContent).toContain('첫 화면')
    })

    test('shows portable project controls on an isolated Share page', async () => {
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character: blankCharacter(), onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-share-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-share-settings]')).not.toBeNull())
        expect(document.body.querySelector('[data-studio-stage-title]')).toBeNull()
        expect(document.body.querySelector('[data-studio-export-project]')).not.toBeNull()
        expect(document.body.querySelector('[data-studio-import-project]')).not.toBeNull()
        expect(document.body.querySelector('[data-studio-compatibility-toggle]')).not.toBeNull()
    })

    test('keeps the editable completion source while syncing Risu-compatible fields on save', async () => {
        const character = blankCharacter()
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-share-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-fallback-message]')).not.toBeNull())
        const fallback = document.body.querySelector<HTMLTextAreaElement>('[data-studio-fallback-message]')!
        expect(fallback.value).toBe('Hello')
        fallback.value = 'Editable ending'
        fallback.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()

        await vi.waitFor(() => expect(character.firstMessageStudio?.fallbackMessage).toBe('Editable ending'))
        expect(character.firstMessage).toContain('Editable ending')
        expect(character.firstMessage).toContain('data-first-message-studio-compatible')
        expect(character.defaultVariables).toContain('first_message_studio_done=0')
    })

    test('resets the current chat to the first Studio screen when project settings are saved', async () => {
        const character = blankCharacter()
        const project = createBlankStudioProject()
        project.completionVariable = 'setup_done'
        project.stageVariable = 'setup_page'
        character.firstMessageStudio = project
        character.chatPage = 0
        character.chats = [{ scriptstate: { $setup_done: '0', $setup_page: 'stage-2', $keep: 'yes' } }] as any
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()

        await vi.waitFor(() => expect(character.chats[0].scriptstate?.$setup_page).toBe('welcome'))
        expect(character.chats[0].scriptstate).toMatchObject({ $setup_done: '0', $keep: 'yes' })
    })

    test('exports the current project and imports a portable project into the draft', async () => {
        const imported = createBlankStudioProject()
        imported.stages[0].title = { ko: '가져온 화면', ja: 'Imported', en: 'Imported' }
        imported.fallbackMessage = 'Imported ending'
        selectFileByDom.mockResolvedValue([new File([
            JSON.stringify({ type: 'risubard-first-message-studio', version: 1, project: imported }),
        ], 'studio.json', { type: 'application/json' })])
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character: blankCharacter(), onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-share-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-export-project]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-studio-export-project]')!.click()
        await vi.waitFor(() => expect(downloadFile).toHaveBeenCalledOnce())
        expect(new TextDecoder().decode(downloadFile.mock.calls[0][1])).toContain('risubard-first-message-studio')

        document.body.querySelector<HTMLButtonElement>('[data-studio-import-project]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector<HTMLTextAreaElement>('[data-studio-fallback-message]')?.value).toBe('Imported ending'))
        document.body.querySelector<HTMLButtonElement>('[data-studio-editor-stage]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector<HTMLInputElement>('[data-studio-stage-title]')?.value).toBe('가져온 화면'))
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

    test('opens language settings as an isolated primary page and returns to screen editing from the rail', async () => {
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character: blankCharacter(), onClose: vi.fn() },
        })

        const tabs = document.body.querySelectorAll<HTMLButtonElement>('[data-studio-primary-toolbar] button')
        expect(tabs[0].textContent?.trim()).toBe('언어')
        tabs[0].click()

        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-language-settings]')).not.toBeNull())
        expect(document.body.querySelector('[data-studio-stage-title]')).toBeNull()
        expect(document.body.querySelector('[data-studio-project-settings]')).toBeNull()

        document.body.querySelector<HTMLButtonElement>('[data-studio-editor-stage]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-stage-title]')).not.toBeNull())
        expect(document.body.querySelector('[data-studio-language-settings]')).toBeNull()
    })

    test('configures arbitrary languages and exposes them in the top editing selector', async () => {
        const character = blankCharacter()
        const project = createBlankStudioProject() as any
        project.localization = {
            variable: 'message_language',
            defaultLanguage: 'ko',
            languages: [
                { id: 'ko', label: '한국어', value: 'kr' },
                { id: 'fr', label: 'Français', value: 'fr' },
            ],
        }
        character.firstMessageStudio = project
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        const selector = document.body.querySelector<HTMLSelectElement>('[data-studio-edit-language]')
        expect(selector).not.toBeNull()
        expect([...selector!.options].map((option) => option.textContent?.trim())).toEqual(['한국어', 'Français'])

        document.body.querySelector<HTMLButtonElement>('[data-studio-languages-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-language-settings]')).not.toBeNull())
        expect(document.body.querySelector<HTMLInputElement>('[data-studio-language-variable]')?.value).toBe('message_language')
    })

    test('keeps screen tools separate and explains project-wide automatic translation', () => {
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character: blankCharacter(), onClose: vi.fn() },
        })

        const screenToolbar = document.body.querySelector<HTMLElement>('[data-studio-screen-toolbar]')!
        expect(screenToolbar).not.toBeNull()
        expect(screenToolbar.textContent).not.toContain('선택한 언어의 입력 필드만 바뀝니다.')
        const translate = screenToolbar.querySelector<HTMLButtonElement>('[data-studio-ai-translation-toggle]')!
        expect(translate.textContent?.trim()).toBe('UI 자동번역')
        expect(translate.title).toContain('프로젝트의 모든 화면')
        expect(screenToolbar.querySelector('[data-studio-edit-language]')).not.toBeNull()
    })

    test('keeps the selected option column count visible after changing it', async () => {
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character: blankCharacter(), onClose: vi.fn() },
        })
        document.body.querySelector<HTMLButtonElement>('[data-studio-design-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-option-columns]')).not.toBeNull())
        const columns = document.body.querySelector<HTMLSelectElement>('[data-studio-option-columns]')!
        columns.value = '3'
        columns.dispatchEvent(new Event('change', { bubbles: true }))

        await vi.waitFor(() => expect(columns.value).toBe('3'))
        expect(columns.selectedOptions[0]?.textContent).toBe('3개')
    })

    test('translates all visible fields with the main model and applies the target language', async () => {
        const character = blankCharacter()
        const project = createBlankStudioProject()
        project.localization.languages = [
            { id: 'ko', label: '한국어', value: 'kr' },
            { id: 'fr', label: 'Français', value: 'fr' },
        ]
        project.localization.defaultLanguage = 'ko'
        character.firstMessageStudio = project
        requestChatData.mockImplementation(async (request, model) => {
            expect(model).toBe('model')
            expect(request.formated).toHaveLength(1)
            expect(request.formated[0].role).toBe('user')
            const payload = JSON.parse(request.formated[0].content.trim().split('\n').at(-1))
            return {
                type: 'success',
                result: JSON.stringify({
                    translations: payload.items.map((item) => ({ id: item.id, text: `FR:${item.text}` })),
                }),
            }
        })

        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })
        document.body.querySelector<HTMLButtonElement>('[data-studio-ai-translation-toggle]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-ai-translation-panel]')).not.toBeNull())
        const target = document.body.querySelector<HTMLSelectElement>('[data-studio-ai-target-language]')!
        target.value = 'fr'
        target.dispatchEvent(new Event('change', { bubbles: true }))
        const translate = document.body.querySelector<HTMLButtonElement>('[data-studio-ai-translate]')!
        expect(translate.disabled).toBe(false)
        translate.click()

        await vi.waitFor(() => expect(requestChatData).toHaveBeenCalledOnce())
        const editLanguage = document.body.querySelector<HTMLSelectElement>('[data-studio-edit-language]')!
        editLanguage.value = 'fr'
        editLanguage.dispatchEvent(new Event('change', { bubbles: true }))
        await vi.waitFor(() => expect(document.body.querySelector<HTMLInputElement>('[data-studio-stage-title]')?.value).toBe('FR:첫 화면'))
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
