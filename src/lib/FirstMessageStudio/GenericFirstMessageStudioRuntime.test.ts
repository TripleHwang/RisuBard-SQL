// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest'
import { mount, unmount } from 'svelte'
import { normalizeFirstMessageStudioProject } from 'src/ts/firstMessageStudio'
import FirstMessageStudioRuntime from './FirstMessageStudioRuntime.svelte'

let mounted: ReturnType<typeof mount> | undefined

describe('generic FirstMessageStudioRuntime', () => {
    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
    })

    test('renders a neutral window and sanitized advanced presentation', () => {
        const project = normalizeFirstMessageStudioProject({
            enabled: true,
            title: 'Character setup',
            customCss: '.studio-extra { letter-spacing: 1px; }',
            customHtml: '<div class="studio-extra">Extra</div><script>window.bad = true</script>',
            stages: [{ id: 'start', tag: 'STEP', title: 'Choose', description: 'Pick one', options: [] }],
        })
        mounted = mount(FirstMessageStudioRuntime, { target: document.body, props: { project, preview: true } })

        expect(document.body.textContent).toContain('Character setup')
        expect(document.body.textContent).toContain('Choose')
        expect(document.body.querySelector('[data-studio-extra]')?.innerHTML).toContain('studio-extra')
        expect(document.body.querySelector('[data-studio-extra]')?.innerHTML).not.toContain('<script')
        expect(document.body.querySelector('[data-studio-custom-css]')?.textContent).toContain('@scope (#fmstudio-')
        expect(document.body.querySelector('[data-studio-back]')).not.toBeNull()
    })
})
