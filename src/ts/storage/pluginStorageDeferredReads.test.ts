import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
    canDeleteAssetsAfterPluginStorageScan,
    collectDatabaseAssetReferences,
    pluginStorageAssetReferencesComplete,
    shouldDeleteUnreferencedAsset,
} from './assetRefs'
import { setDatabase } from './database.svelte'
import { DBState } from '../stores.svelte'
import { markRootKeyDeferred, resetDeferredRootKeys } from './sql/deferredRootKeys'

let previousDatabase: any

beforeEach(() => {
    resetDeferredRootKeys()
    previousDatabase = DBState.db
})

afterEach(() => {
    resetDeferredRootKeys()
    DBState.db = previousDatabase
})

describe('database normalization with a deferred pluginCustomStorage', () => {
    it('fills in an empty map when the key is genuinely missing', () => {
        setDatabase({ characters: [], botPresets: [] } as any)

        expect(DBState.db.pluginCustomStorage).toEqual({})
    })

    it('leaves a deferred key absent instead of defaulting it to an empty map', () => {
        markRootKeyDeferred('pluginCustomStorage')

        setDatabase({ characters: [], botPresets: [] } as any)

        // `{}` here would be the database asserting that the user has no plugin
        // storage, which is exactly the conclusion nothing is allowed to draw
        // from a key that was withheld rather than read.
        expect(DBState.db.pluginCustomStorage).toBeUndefined()
    })

    it('does not clobber a map that is already resident', () => {
        markRootKeyDeferred('pluginCustomStorage')

        setDatabase({ characters: [], botPresets: [], pluginCustomStorage: { a: 1 } } as any)

        expect(DBState.db.pluginCustomStorage).toEqual({ a: 1 })
    })
})

describe('asset cleanup with a deferred pluginCustomStorage', () => {
    const database = {
        nodeOnlyAutoCleanAssets: true,
        characters: [],
        pluginCustomStorage: { 'plugin.avatar': 'assets/plugin-avatar.png' },
    } as any

    it('finds plugin storage asset references while the map is resident', () => {
        expect([...collectDatabaseAssetReferences(database)]).toContain('assets/plugin-avatar.png')
        expect(pluginStorageAssetReferencesComplete(database)).toBe(true)
    })

    it('reports references as incomplete while the map is deferred', () => {
        markRootKeyDeferred('pluginCustomStorage')
        const withheld = { nodeOnlyAutoCleanAssets: true, characters: [] } as any

        // The reference scan cannot see the rows, so it reports nothing — which
        // is the input `shouldDeleteUnreferencedAsset` would treat as "this
        // asset is unreferenced, delete it".
        expect([...collectDatabaseAssetReferences(withheld)]).toEqual([])
        expect(pluginStorageAssetReferencesComplete(withheld)).toBe(false)
    })

    it('blocks unreferenced-asset deletion while the references are unknown', () => {
        markRootKeyDeferred('pluginCustomStorage')
        const withheld = { nodeOnlyAutoCleanAssets: true, characters: [] } as any

        const cleanAssets = canDeleteAssetsAfterPluginStorageScan(
            true,
            pluginStorageAssetReferencesComplete(withheld),
        )

        expect(cleanAssets).toBe(false)
        expect(shouldDeleteUnreferencedAsset('assets/plugin-avatar.png', cleanAssets, new Set()))
            .toBe(false)
    })
})
