import { afterEach, describe, expect, test, vi } from 'vitest'

import { markRootKeyDeferred, resetDeferredRootKeys } from '../storage/sql/deferredRootKeys'
import { ensurePluginIdentities, findInstalledPlugin, pluginIdentityKey, type RisuPlugin } from './plugins.svelte'

function installed(overrides: Partial<RisuPlugin> & { name: string }): RisuPlugin {
    return {
        script: '',
        arguments: {},
        realArg: {},
        customLink: [],
        argMeta: {},
        ...overrides,
    }
}

afterEach(() => {
    resetDeferredRootKeys()
    vi.restoreAllMocks()
})

describe('plugin install identity', () => {
    test('backfills an id for every record that has none', () => {
        const plugins = [
            installed({ name: 'risu_multiagent' }),
            installed({ name: 'flashback_memory' }),
        ]

        expect(ensurePluginIdentities(plugins)).toBe(2)
        expect(plugins[0].id).toBeTruthy()
        expect(plugins[1].id).toBeTruthy()
        expect(plugins[0].id).not.toBe(plugins[1].id)
    })

    test('is a no-op once every record has an id', () => {
        const plugins = [installed({ name: 'a' }), installed({ name: 'b' })]
        ensurePluginIdentities(plugins)
        const before = plugins.map((plugin) => plugin.id)

        expect(ensurePluginIdentities(plugins)).toBe(0)
        expect(plugins.map((plugin) => plugin.id)).toEqual(before)
    })

    test('re-mints a duplicated id, keeping the first holder', () => {
        // Two installs answering to one identity is the same wrong-record
        // lookup the id exists to prevent.
        const plugins = [
            installed({ name: 'a', id: 'shared' }),
            installed({ name: 'b', id: 'shared' }),
        ]

        expect(ensurePluginIdentities(plugins)).toBe(1)
        expect(plugins[0].id).toBe('shared')
        expect(plugins[1].id).not.toBe('shared')
        expect(plugins[1].id).toBeTruthy()
    })

    test('writes nothing while the plugin list is deferred', () => {
        // "Not loaded" is not "no plugins". Assigning ids to a list that was
        // never read would persist that partial list over the real one.
        markRootKeyDeferred('plugins')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const plugins = [installed({ name: 'risu_multiagent' })]

        expect(ensurePluginIdentities(plugins)).toBe(0)
        expect(plugins[0].id).toBeUndefined()
        expect(warn).toHaveBeenCalled()
    })

    test('an undefined plugin list is left alone', () => {
        expect(ensurePluginIdentities(undefined)).toBe(0)
    })

    test('findInstalledPlugin resolves by id and never falls back to a name', () => {
        const plugins = [
            installed({ name: 'risu_multiagent', id: 'install-1' }),
            installed({ name: 'flashback_memory', id: 'install-2' }),
        ]

        expect(findInstalledPlugin(plugins, { id: 'install-1', name: 'anything' })).toBe(plugins[0])
        // The rename case: the target's id is the truth, not the new name.
        expect(findInstalledPlugin(plugins, { id: 'install-1', name: 'flashback_memory' })).toBe(plugins[0])
        // A missing id means the install is gone, not "take the same-named one".
        expect(findInstalledPlugin(plugins, { id: 'install-9', name: 'risu_multiagent' })).toBeUndefined()
    })

    test('findInstalledPlugin matches by name only for records with no id', () => {
        const plugins = [
            installed({ name: 'legacy_plugin' }),
            installed({ name: 'legacy_plugin', id: 'install-2' }),
        ]

        expect(findInstalledPlugin(plugins, { name: 'legacy_plugin' })).toBe(plugins[0])
        expect(findInstalledPlugin(undefined, { name: 'legacy_plugin' })).toBeUndefined()
    })

    test('the cache key prefers the id and cannot collide with one', () => {
        expect(pluginIdentityKey({ id: 'install-1', name: 'a' })).toBe('install-1')
        expect(pluginIdentityKey({ name: 'a' })).toBe('name:a')
        expect(pluginIdentityKey({ name: 'install-1' })).not.toBe(pluginIdentityKey({ id: 'install-1', name: 'x' }))
    })
})
