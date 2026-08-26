import { describe, expect, test } from 'vitest'
import { createBlankStudioProject } from 'src/ts/firstMessageStudio'
import {
    readFirstMessageStudioVariables,
    resetFirstMessageStudioScriptstate,
    shouldRenderFirstMessageStudio,
    writeFirstMessageStudioVariables,
} from 'src/ts/firstMessageStudio'
import { canApplyResolvedChatImage, clearGenericChatImageStyles, createChatAssetUrlResolver, isFirstMessageStudioManagedImage } from './chatImageHandling'

describe('first message studio chat integration', () => {
    test('keeps Studio presentation assets out of generic chat image styling', () => {
        document.body.innerHTML = `<div data-first-message-studio-compatible><div><img id="studio-image" class="root-loaded-image root-loaded-image-dynamic keep-me"></div></div><img id="ordinary-image">`

        const studioImage = document.querySelector('#studio-image')!
        expect(isFirstMessageStudioManagedImage(studioImage)).toBe(true)
        expect(isFirstMessageStudioManagedImage(document.querySelector('#ordinary-image')!)).toBe(false)
        clearGenericChatImageStyles(studioImage)
        expect(studioImage.className).toBe('keep-me')
    })

    test('shares an in-flight module asset URL lookup and retries an empty result', async () => {
        let calls = 0
        let resolveFirst: (value: string) => void = () => {}
        const resolver = createChatAssetUrlResolver(() => {
            calls += 1
            return new Promise<string>((resolve) => { resolveFirst = resolve })
        })

        const first = resolver('assets/module-image.png')
        const second = resolver('assets/module-image.png')
        expect(calls).toBe(1)
        resolveFirst('blob:module-image')
        await expect(first).resolves.toBe('blob:module-image')
        await expect(second).resolves.toBe('blob:module-image')

        let emptyCalls = 0
        const retry = createChatAssetUrlResolver(async () => {
            emptyCalls += 1
            return ''
        })
        await retry('assets/retry.png')
        await retry('assets/retry.png')
        // Empty results are not kept, avoiding a permanent broken image after
        // a transient storage/service-worker miss.
        // The two calls must therefore each invoke their loader.
        expect(emptyCalls).toBe(2)
    })

    test('does not apply an asset URL after the image has been rerendered', () => {
        const image = document.createElement('img')
        image.setAttribute('src', 'module-image.png')
        expect(canApplyResolvedChatImage(image, 'module-image.png')).toBe(true)

        image.setAttribute('src', 'replacement-image.png')
        expect(canApplyResolvedChatImage(image, 'module-image.png')).toBe(false)
    })

    test('renders only for an enabled incomplete first message', () => {
        const project = createBlankStudioProject()
        expect(shouldRenderFirstMessageStudio(true, project, {}, 'first_message_studio_done=0')).toBe(true)
        expect(shouldRenderFirstMessageStudio(false, project, {}, 'first_message_studio_done=0')).toBe(false)
        expect(shouldRenderFirstMessageStudio(true, { ...project, enabled: false }, {}, 'first_message_studio_done=0')).toBe(false)
        expect(shouldRenderFirstMessageStudio(true, project, { $first_message_studio_done: '1' }, 'first_message_studio_done=0')).toBe(false)
    })

    test('reads defaults and scriptstate with chat values taking precedence', () => {
        expect(readFirstMessageStudioVariables(
            { $language: 'en', unrelated: 'ignored' },
            'language=ko\nfirst_message_studio_done=0\nempty=',
        )).toEqual({ language: 'en', first_message_studio_done: '0', empty: '' })
    })

    test('writes immutable dollar-prefixed chat scriptstate', () => {
        const original = { $keep: 'yes' }
        const written = writeFirstMessageStudioVariables(original, { language: 'ja', first_message_studio_done: '1' })

        expect(written).toEqual({ $keep: 'yes', $language: 'ja', $first_message_studio_done: '1' })
        expect(original).toEqual({ $keep: 'yes' })
    })

    test('resets stale Studio progress to the configured first screen', () => {
        const project = createBlankStudioProject()
        project.completionVariable = 'setup_done'
        project.stageVariable = 'setup_page'
        project.variables = [{ name: 'route', label: 'Route', defaultValue: 'default', choices: [] }]
        const original = { $setup_done: '1', $setup_page: 'stage-2', $route: 'old', $keep: 'yes' }

        expect(resetFirstMessageStudioScriptstate(project, original)).toEqual({
            $setup_done: '0',
            $setup_page: 'welcome',
            $route: 'default',
            $cv_lang: '1',
            $keep: 'yes',
        })
        expect(original.$setup_page).toBe('stage-2')
    })
})
