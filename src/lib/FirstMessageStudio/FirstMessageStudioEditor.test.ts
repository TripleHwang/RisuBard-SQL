// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import type { character } from 'src/ts/storage/database.svelte'
import { createBlankStudioProject } from 'src/ts/firstMessageStudio'
import FirstMessageStudioEditor from './FirstMessageStudioEditor.svelte'

const requestChatData = vi.hoisted(() => vi.fn())
const downloadFile = vi.hoisted(() => vi.fn())
const getFileSrc = vi.hoisted(() => vi.fn())
const saveAsset = vi.hoisted(() => vi.fn())
const selectFileByDom = vi.hoisted(() => vi.fn())
vi.mock('src/ts/process/request/request', () => ({ requestChatData }))
vi.mock('src/ts/globalApi.svelte', () => ({ downloadFile, getFileSrc, saveAsset }))
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
        getFileSrc.mockReset()
        saveAsset.mockReset()
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
        const titleRow = document.body.querySelector('[data-studio-title-row]')
        const enabledToggle = document.body.querySelector<HTMLLabelElement>('[data-studio-enabled-toggle]')
        expect(titleRow?.textContent).toContain('누구나 쉽게 만드는 퍼스트 메시지')
        expect(enabledToggle?.textContent?.replace(/\s/g, '')).toBe('스튜디오사용')
        expect(titleRow?.contains(enabledToggle)).toBe(true)
        expect(enabledToggle?.querySelector('[data-studio-enabled-track]')).not.toBeNull()
        expect(document.body.querySelector('[data-studio-top-actions]')?.contains(enabledToggle)).toBe(false)
        expect(document.body.textContent).toContain('언어')
        expect(document.body.textContent).toContain('변수')
        expect(document.body.textContent).toContain('시나리오')
        expect(document.body.textContent).toContain('창 디자인')
        expect(document.body.textContent).toContain('고급 코드')
        expect(document.body.textContent).toContain('공유')
        expect(document.body.querySelectorAll('[data-studio-editor-stage]')).toHaveLength(1)
        expect(document.body.textContent).toContain('첫 화면')
    })

    test('builds localized scenarios from AND groups containing OR conditions', async () => {
        const character = blankCharacter()
        const project = createBlankStudioProject()
        project.stages[0].options = [{
            id: 'route', label: 'Route', effects: [{ variable: 'route', value: 'calm' }], completes: true,
        }]
        character.firstMessageStudio = project
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-scenarios-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-scenario-settings]')).not.toBeNull())
        document.body.querySelector<HTMLButtonElement>('[data-studio-add-scenario]')!.click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-scenario-rule]')).toHaveLength(1))

        const label = document.body.querySelector<HTMLInputElement>('[data-studio-scenario-label]')!
        label.value = 'Calm opening'
        label.dispatchEvent(new Event('input', { bubbles: true }))
        const variable = document.body.querySelector<HTMLInputElement>('[data-studio-scenario-variable]')!
        expect([...document.body.querySelectorAll<HTMLOptionElement>('[data-studio-scenario-variables] option')].map((option) => option.value)).toContain('route')
        variable.value = 'route'
        variable.dispatchEvent(new Event('input', { bubbles: true }))
        const value = document.body.querySelector<HTMLInputElement>('[data-studio-scenario-value]')!
        value.value = 'calm'
        value.dispatchEvent(new Event('input', { bubbles: true }))

        document.body.querySelector<HTMLButtonElement>('[data-studio-add-condition]')!.click()
        document.body.querySelector<HTMLButtonElement>('[data-studio-add-condition-group]')!.click()
        await vi.waitFor(() => {
            expect(document.body.querySelectorAll('[data-studio-scenario-group]')).toHaveLength(2)
            expect(document.body.querySelectorAll('[data-studio-scenario-condition]')).toHaveLength(3)
        })
        const message = document.body.querySelector<HTMLTextAreaElement>('[data-studio-scenario-message]')!
        message.value = '차분한 도입부'
        message.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()

        await vi.waitFor(() => expect(character.firstMessageStudio?.scenarioRules).toHaveLength(1))
        expect(character.firstMessageStudio?.scenarioRules[0]).toMatchObject({
            label: 'Calm opening',
            message: { ko: '차분한 도입부' },
            groups: [{ conditions: [{ variable: 'route', operator: 'equals', value: 'calm' }, {}] }, { conditions: [{}] }],
        })
    })

    test('reorders and deletes scenario rules', async () => {
        const character = blankCharacter()
        const project = createBlankStudioProject()
        project.scenarioRules = [
            { id: 'first', label: 'First', message: 'One', groups: [{ id: 'g1', conditions: [{ variable: 'route', operator: 'equals', value: '1' }] }] },
            { id: 'second', label: 'Second', message: 'Two', groups: [{ id: 'g2', conditions: [{ variable: 'route', operator: 'equals', value: '2' }] }] },
        ]
        character.firstMessageStudio = project
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-scenarios-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-scenario-rule]')).toHaveLength(2))
        document.body.querySelectorAll<HTMLButtonElement>('[data-studio-move-scenario-up]')[1].click()
        await vi.waitFor(() => expect(document.body.querySelector<HTMLInputElement>('[data-studio-scenario-label]')?.value).toBe('Second'))
        document.body.querySelectorAll<HTMLButtonElement>('[data-studio-delete-scenario]')[1].click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-scenario-rule]')).toHaveLength(1))
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

    test('recovers a legacy completion source when an existing Studio project has an empty fallback', async () => {
        const character = blankCharacter()
        character.firstMessage = 'Legacy Persona scenario source'
        character.firstMessageStudio = createBlankStudioProject()
        character.firstMessageStudio.fallbackMessage = ''
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-share-tab]')!.click()

        await vi.waitFor(() => expect(document.body.querySelector<HTMLTextAreaElement>('[data-studio-fallback-message]')?.value).toBe('Legacy Persona scenario source'))
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

    test('shows registered variables as compact rows with explanatory tooltips', async () => {
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

        expect(document.body.querySelector('[data-studio-add-variable-choice]')).toBeNull()
        expect(document.body.querySelector('[data-studio-variable-choice]')).toBeNull()
        expect(document.body.textContent).not.toContain('선택 가능한 값')
        expect(document.body.querySelector('[data-studio-variable-name-label]')?.getAttribute('title')).toContain('조건식')
        expect(document.body.querySelector('[data-studio-variable-label-label]')?.getAttribute('title')).toContain('화면')
        expect(document.body.querySelector('[data-studio-variable-default-label]')?.getAttribute('title')).toContain('선택하기 전')
        expect(document.body.querySelector('[data-studio-delete-variable]')?.getAttribute('title')).toContain('기본값')

        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()
        await vi.waitFor(() => expect(character.firstMessageStudio?.variables[0].name).toBe('route'))
    })

    test('reorders and deletes variables from the compact list', async () => {
        const character = blankCharacter()
        const project = createBlankStudioProject()
        project.variables = [
            { name: 'persona', label: '페르소나', defaultValue: '1', choices: [] },
            { name: 'scenario', label: '시나리오', defaultValue: '2', choices: [] },
        ]
        character.firstMessageStudio = project
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        document.body.querySelector<HTMLButtonElement>('[data-studio-variables-tab]')!.click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-variable]')).toHaveLength(2))
        document.body.querySelectorAll<HTMLButtonElement>('[data-studio-move-variable-up]')[1].click()
        await vi.waitFor(() => expect(document.body.querySelector<HTMLInputElement>('[data-studio-variable-name]')?.value).toBe('scenario'))
        document.body.querySelectorAll<HTMLButtonElement>('[data-studio-delete-variable]')[1].click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-variable]')).toHaveLength(1))
        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()

        await vi.waitFor(() => expect(character.firstMessageStudio?.variables.map((variable) => variable.name)).toEqual(['scenario']))
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

    test('edits option presentations in tabs and saves uploaded illustrations as character assets', async () => {
        getFileSrc.mockResolvedValue('data:image/webp;base64,FARMER')
        saveAsset.mockResolvedValue('assets/farmer-hash.webp')
        selectFileByDom.mockResolvedValue([new File(['farmer-image'], 'farmer.webp', { type: 'image/webp' })])
        const character = blankCharacter()
        const project = createBlankStudioProject()
        project.stages[0].title = 'Persona selection'
        project.stages[0].options = [
            { id: 'farmer', label: 'Farmer', effects: [] },
            { id: 'warrior', label: 'Warrior', effects: [] },
        ]
        character.firstMessageStudio = project
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        expect(document.body.querySelector('[data-studio-option-presentation-editor]')).toBeNull()
        document.body.querySelector<HTMLInputElement>('[data-studio-option-presentation-toggle]')!.click()
        await vi.waitFor(() => expect(document.body.querySelectorAll('[data-studio-presentation-tab]')).toHaveLength(2))
        expect(document.body.querySelector('[data-studio-presentation-tab="farmer"]')?.classList.contains('active')).toBe(true)

        const speaker = document.body.querySelector<HTMLInputElement>('[data-studio-presentation-speaker]')!
        speaker.value = '농부'
        speaker.dispatchEvent(new Event('input', { bubbles: true }))
        const description = document.body.querySelector<HTMLTextAreaElement>('[data-studio-presentation-description]')!
        description.value = '오늘도 당신은 밭에서 이삭을 줍습니다.'
        description.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLInputElement>('[data-studio-presentation-image-toggle]')!.click()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-upload-presentation-image]')).not.toBeNull())
        const frameSelect = document.body.querySelector<HTMLSelectElement>('[data-studio-presentation-image-frame]')!
        expect([...frameSelect.options].map((option) => option.value)).toEqual(['contain', 'square', 'landscape', 'portrait'])
        frameSelect.value = 'landscape'
        frameSelect.dispatchEvent(new Event('change', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-studio-upload-presentation-image]')!.click()

        await vi.waitFor(() => expect(saveAsset).toHaveBeenCalledOnce())
        expect(character.additionalAssets).toEqual([['fmstudio-welcome-farmer-farmer.webp', 'assets/farmer-hash.webp', 'webp']])
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-presentation-asset-name]')?.textContent).toContain('farmer.webp'))
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-image-crop-editor]')).not.toBeNull())
        expect(document.body.querySelector('[data-studio-image-crop-guide]')).not.toBeNull()
        const cropFrame = document.body.querySelector<HTMLElement>('[data-studio-image-crop-frame]')!
        cropFrame.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON: () => ({}) })
        cropFrame.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }))
        cropFrame.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 75 }))
        cropFrame.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 75 }))
        document.body.querySelector<HTMLButtonElement>('[data-studio-save]')!.click()

        await vi.waitFor(() => expect(character.firstMessageStudio?.stages[0].optionPresentationEnabled).toBe(true))
        expect(character.firstMessageStudio?.stages[0].options[0].presentation).toMatchObject({
            speaker: { ko: '농부' },
            description: { ko: '오늘도 당신은 밭에서 이삭을 줍습니다.' },
            imageEnabled: true,
            imageFrame: 'landscape',
            imagePositionX: 50,
            imagePositionY: 25,
            imageAssetName: 'fmstudio-welcome-farmer-farmer.webp',
        })
    })

    test('applies dragged crop positions to the live preview immediately', async () => {
        getFileSrc.mockResolvedValue('data:image/webp;base64,FARMER')
        const character = blankCharacter()
        character.additionalAssets = [['farmer.webp', 'assets/farmer.webp', 'webp']]
        const project = createBlankStudioProject()
        project.stages[0].optionPresentationEnabled = true
        project.stages[0].options = [{
            id: 'farmer', label: 'Farmer', effects: [], presentation: {
                speaker: 'Farmer', description: 'A farmer.', imageEnabled: true,
                imageFrame: 'landscape', imagePositionX: 50, imagePositionY: 50,
                imageAssetName: 'farmer.webp',
            },
        }]
        character.firstMessageStudio = project
        mounted = mount(FirstMessageStudioEditor, {
            target: document.body,
            props: { character, onClose: vi.fn() },
        })

        await vi.waitFor(() => expect(document.body.querySelector<HTMLImageElement>('[data-studio-presentation-image]')?.style.objectPosition).toBe('50% 50%'))
        const cropFrame = document.body.querySelector<HTMLElement>('[data-studio-image-crop-frame]')!
        cropFrame.getBoundingClientRect = () => ({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON: () => ({}) })
        cropFrame.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 100, clientY: 50 }))
        cropFrame.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 100, clientY: 75 }))
        cropFrame.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 100, clientY: 75 }))

        await vi.waitFor(() => expect(document.body.querySelector<HTMLImageElement>('[data-studio-presentation-image]')?.style.objectPosition).toBe('50% 25%'))
        expect(document.body.querySelector<HTMLImageElement>('[data-studio-presentation-image]')?.style.getPropertyPriority('object-position')).toBe('important')
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
            optionPresentationEnabled: false,
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
