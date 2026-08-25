// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import { normalizeFirstMessageStudioProject, type FirstMessageStudioRuntime as RuntimeState } from 'src/ts/firstMessageStudio'

const getFileSrc = vi.hoisted(() => vi.fn())
vi.mock('src/ts/globalApi.svelte', () => ({ getFileSrc }))

import FirstMessageStudioRuntime from './FirstMessageStudioRuntime.svelte'

let mounted: ReturnType<typeof mount> | undefined

function projectFixture() {
    return normalizeFirstMessageStudioProject({
        enabled: true,
        title: 'Setup',
        completionVariable: 'done',
        variables: [{ name: 'route', label: 'Route', defaultValue: '', choices: [] }],
        startStageId: 'route',
        stages: [
            { id: 'route', tag: 'STEP', title: 'Route', description: 'Choose.', options: [
                { id: 'calm', label: 'Calm', effects: [{ variable: 'route', value: 'calm' }], nextStageId: 'name' },
            ] },
            { id: 'name', tag: 'STEP', title: 'Name', description: 'Enter a name.', options: [
                { id: 'finish', label: 'Finish', effects: [], input: { variable: 'name', label: 'Name', required: true }, completes: true },
            ] },
        ],
    })
}

function clickOption(id: string) {
    document.body.querySelector<HTMLButtonElement>(`[data-studio-option="${id}"]`)!.click()
}

describe('FirstMessageStudioRuntime', () => {
    beforeEach(() => {
        localStorage.setItem('risu-lang', 'ko')
        getFileSrc.mockReset()
    })

    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
        localStorage.clear()
    })

    test('renders generic progress and follows choices', async () => {
        const onChange = vi.fn<(runtime: RuntimeState) => void>()
        mounted = mount(FirstMessageStudioRuntime, { target: document.body, props: { project: projectFixture(), onChange } })

        expect(document.body.textContent).toContain('Setup')
        expect(document.body.textContent).toContain('Route')
        expect(document.body.querySelectorAll('.progress span')).toHaveLength(2)

        clickOption('calm')
        await vi.waitFor(() => expect(document.body.textContent).toContain('Enter a name.'))
        expect(onChange.mock.calls.at(-1)?.[0].variables.route).toBe('calm')
    })

    test('validates direct input, completes, goes back, and resets preview', async () => {
        mounted = mount(FirstMessageStudioRuntime, { target: document.body, props: { project: projectFixture(), preview: true } })
        clickOption('calm')
        await vi.waitFor(() => expect(document.body.textContent).toContain('Finish'))
        clickOption('finish')
        await vi.waitFor(() => expect(document.body.textContent).toContain('입력값이 필요합니다'))

        const input = document.body.querySelector<HTMLInputElement>('[data-studio-input="name"]')!
        input.value = 'Ari'
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.body.querySelector<HTMLButtonElement>('[data-studio-back]')!.click()
        await vi.waitFor(() => expect(document.body.textContent).toContain('Choose.'))
        clickOption('calm')
        document.body.querySelector<HTMLButtonElement>('[data-studio-reset]')!.click()
        await vi.waitFor(() => expect(document.body.textContent).toContain('Choose.'))
    })

    test('applies reusable skins without adding specialized controls', () => {
        const project = projectFixture()
        project.appearance = { ...project.appearance, preset: 'glass', showNavigation: false, optionColumns: 1 }
        mounted = mount(FirstMessageStudioRuntime, { target: document.body, props: { project, preview: true } })

        const runtime = document.body.querySelector<HTMLElement>('[data-first-message-studio-runtime]')!
        expect(runtime.dataset.studioSkin).toBe('glass')
        expect(runtime.style.getPropertyValue('--studio-columns')).toBe('1')
        expect(document.body.querySelector('[data-studio-back]')).toBeNull()
        expect(document.body.querySelector('[data-studio-reset]')).not.toBeNull()
    })

    test('uses the global app language when the project has no explicit language variable', () => {
        localStorage.setItem('risu-lang', 'en')
        const project = projectFixture()
        project.stages[0].title = { ko: '방향', ja: '方向', en: 'Route in English' }
        mounted = mount(FirstMessageStudioRuntime, { target: document.body, props: { project } })

        expect(document.body.textContent).toContain('Route in English')
        expect(document.body.textContent).not.toContain('방향')
    })

    test('changes the main presentation on option hover and keyboard focus', async () => {
        getFileSrc.mockResolvedValue('data:image/webp;base64,FARMER')
        const project = projectFixture()
        project.stages[0].optionPresentationEnabled = true
        project.stages[0].options = [
            {
                id: 'farmer', label: 'Farmer', effects: [], presentation: {
                    speaker: 'Farmer', description: 'You gather grain in the field.', imageEnabled: true, imageFrame: 'portrait', imagePositionX: 35, imagePositionY: 65, imageAssetName: 'farmer.webp',
                },
            },
            {
                id: 'warrior', label: 'Warrior', effects: [], presentation: {
                    speaker: 'Warrior', description: 'You trust your inherited sword.', imageEnabled: false, imageFrame: 'contain', imagePositionX: 50, imagePositionY: 50, imageAssetName: 'warrior.webp',
                },
            },
            {
                id: 'empty', label: 'Empty', effects: [], presentation: {
                    description: '', imageEnabled: false, imageFrame: 'contain', imagePositionX: 50, imagePositionY: 50,
                },
            },
        ]
        mounted = mount(FirstMessageStudioRuntime, {
            target: document.body,
            props: { project, preview: true, assets: [
                ['farmer.webp', 'assets/farmer-hash.webp', 'webp'],
                ['warrior.webp', 'assets/warrior-hash.webp', 'webp'],
            ] },
        })

        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-presentation-speaker]')?.textContent).toBe('Farmer'))
        await vi.waitFor(() => expect(getFileSrc).toHaveBeenCalledWith('assets/farmer-hash.webp'))
        await vi.waitFor(() => expect(document.body.querySelector<HTMLImageElement>('[data-studio-presentation-image]')?.src).toContain('FARMER'))
        const imageFrame = document.body.querySelector<HTMLElement>('[data-studio-presentation-image-frame]')!
        const presentationCopy = document.body.querySelector<HTMLElement>('[data-studio-presentation-copy]')!
        expect(imageFrame.classList.contains('frame-portrait')).toBe(true)
        expect(imageFrame.contains(presentationCopy)).toBe(false)
        const presentationImage = document.body.querySelector<HTMLImageElement>('[data-studio-presentation-image]')!
        expect(presentationImage.style.objectPosition).toBe('35% 65%')
        expect(presentationImage.style.getPropertyPriority('object-position')).toBe('important')
        expect(imageFrame.style.position).toBe('relative')
        expect(presentationImage.style.position).toBe('absolute')
        expect(presentationImage.style.getPropertyValue('inset')).toBe('0')
        for (const property of ['width', 'height', 'max-width', 'max-height', 'object-fit', 'margin']) {
            expect(presentationImage.style.getPropertyPriority(property), property).toBe('important')
        }

        document.body.querySelector<HTMLButtonElement>('[data-studio-option="warrior"]')!.dispatchEvent(new Event('pointermove', { bubbles: true }))
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-presentation-speaker]')?.textContent).toBe('Warrior'))
        expect(document.body.textContent).toContain('You trust your inherited sword.')
        expect(document.body.querySelector('[data-studio-presentation-image]')).toBeNull()

        document.body.querySelector<HTMLButtonElement>('[data-studio-option="farmer"]')!.focus()
        await vi.waitFor(() => expect(document.body.querySelector('[data-studio-presentation-speaker]')?.textContent).toBe('Farmer'))

        const emptyOption = document.body.querySelector<HTMLButtonElement>('[data-studio-option="empty"]')!
        emptyOption.dispatchEvent(new Event('pointermove', { bubbles: true }))
        emptyOption.focus()
        expect(document.body.querySelector('[data-studio-presentation-speaker]')?.textContent).toBe('Farmer')
        expect(document.body.textContent).toContain('You gather grain in the field.')
        expect(document.body.querySelector<HTMLImageElement>('[data-studio-presentation-image]')?.src).toContain('FARMER')
        expect(getFileSrc).toHaveBeenCalledTimes(1)
    })
})
