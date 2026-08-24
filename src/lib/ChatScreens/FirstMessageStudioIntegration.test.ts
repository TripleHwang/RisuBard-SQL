import { describe, expect, test } from 'vitest'
import { createBlankStudioProject } from 'src/ts/firstMessageStudio'
import {
    readFirstMessageStudioVariables,
    shouldRenderFirstMessageStudio,
    writeFirstMessageStudioVariables,
} from 'src/ts/firstMessageStudio'

describe('first message studio chat integration', () => {
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
})
