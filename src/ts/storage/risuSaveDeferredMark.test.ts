import { describe, test, expect, vi, afterEach } from 'vitest'

vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))

import { RisuSaveEncoder } from './risuSave'
import {
    isRootKeyDeferred,
    markRootKeyDeferred,
    resetDeferredRootKeys,
} from './sql/deferredRootKeys'

afterEach(() => resetDeferredRootKeys())

const database = (pluginCustomStorage: unknown) => ({
    characters: [],
    botPresets: [],
    plugins: [],
    modules: [],
    pluginCustomStorage,
}) as any

/**
 * The encoder refuses to write a plugin-storage block while the key is deferred,
 * because a deferred key's rows are in storage and not in memory, and encoding
 * one records them as absent.
 *
 * A deferred mark is bookkeeping about the value, not the value. Importing a
 * backup decodes a complete legacy save, so the database really does carry the
 * rows -- and the mark left over from the SQL bootstrap earlier in the same
 * session is stale. Refusing on the mark alone blocked the save that follows an
 * import, reporting a state the database was not in.
 */
describe('encoding while a root key is marked deferred', () => {
    test('encodes when the database carries the value, and drops the stale mark', async () => {
        markRootKeyDeferred('pluginCustomStorage')
        const encoder = new RisuSaveEncoder()

        await expect(
            encoder.init(database({ 'plugin.config': { provider: 'google' } }), { compression: false }),
        ).resolves.not.toThrow()

        expect(isRootKeyDeferred('pluginCustomStorage')).toBe(false)
    })

    test('still refuses when the value really is missing', async () => {
        markRootKeyDeferred('pluginCustomStorage')
        const encoder = new RisuSaveEncoder()

        await expect(
            encoder.init(database(undefined), { compression: false }),
        ).rejects.toThrow(/deferred/)

        // The mark stands: nothing has established what those rows hold.
        expect(isRootKeyDeferred('pluginCustomStorage')).toBe(true)
    })
})
