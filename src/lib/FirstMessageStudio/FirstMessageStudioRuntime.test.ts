// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import { normalizeFirstMessageStudioProject, type FirstMessageStudioRuntime as RuntimeState } from 'src/ts/firstMessageStudio'
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
    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
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
    })
})
