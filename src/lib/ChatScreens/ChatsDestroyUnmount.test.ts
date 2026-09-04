import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/lib/ChatScreens/Chats.svelte'), 'utf8')

/**
 * `mountInstances` maps a message id to `{ instance, element, signature }`, and
 * `onDestroy` passed that record to `unmount` instead of its `instance`. Svelte
 * neither throws nor warns on that -- it simply unmounts nothing, so every chat
 * screen the user left behind kept its sixty mounted `Chat` components alive,
 * with their effects and subscriptions, for the rest of the session.
 *
 * Read from source rather than driven, and deliberately so: destroying the
 * parent removes the rows' DOM either way, so the DOM cannot tell the two apart,
 * and the surviving component instances are not reachable from a test. An
 * assertion that passes under the bug is worse than none -- the first version of
 * this test did exactly that.
 */
describe('destroying the chat screen', () => {
    it('unmounts the component, not the record that holds it', () => {
        const destroy = source.slice(source.indexOf('onDestroy('))
        expect(destroy).toContain('unmount(mounted.instance)')
        expect(destroy).not.toMatch(/unmount\(\s*inst\s*\)/)
    })

    it('unmounts through the same accessor everywhere it unmounts', () => {
        const calls = source.match(/unmount\([^)]*\)/g) ?? []
        expect(calls.length).toBeGreaterThan(2)
        for (const call of calls) expect(call).toContain('.instance')
    })
})
