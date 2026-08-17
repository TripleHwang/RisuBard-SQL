import { describe, expect, test, vi } from 'vitest'
import type { character } from './storage/database.svelte'
import { convertCharbook, createBaseV2, createBaseV3 } from './characterCards'

vi.mock('./process/modules', () => ({
    exportModuleLegacy: vi.fn(),
    getModuleAssets: vi.fn(() => []),
    getModuleLorebooks: vi.fn(() => []),
    getModuleLorebooksWithSources: vi.fn(() => []),
    getModuleMcps: vi.fn(() => []),
    getModuleRegexScripts: vi.fn(() => []),
    getModules: vi.fn(() => []),
    getModuleToggles: vi.fn(() => []),
    getModuleTriggers: vi.fn(() => []),
    moduleUpdate: vi.fn(),
    readModule: vi.fn(),
}))

function nativeCharacter(globalLore: character['globalLore']): character {
    return {
        name: 'Enabled state test',
        globalLore,
        loreExt: {},
    } as character
}

describe('Character Card lorebook enabled state', () => {
    test('imports explicit false and treats a missing card field as enabled', () => {
        const imported = convertCharbook({
            lorebook: [],
            charbook: {
                extensions: {},
                entries: [
                    {
                        keys: ['disabled'],
                        content: 'Disabled lore',
                        extensions: {},
                        enabled: false,
                        insertion_order: 10,
                        name: 'Disabled lore',
                    },
                    {
                        keys: ['legacy'],
                        content: 'Legacy lore',
                        extensions: {},
                        insertion_order: 20,
                        name: 'Legacy lore',
                    } as never,
                ],
            },
            loresettings: undefined,
            loreExt: undefined,
        }).lorebook

        expect(imported.map((entry) => entry.enabled)).toEqual([false, true])
    })

    test('exports native false as false and missing native state as enabled', () => {
        const exported = createBaseV3(nativeCharacter([
            {
                id: 'disabled-id',
                key: 'disabled',
                secondkey: '',
                insertorder: 10,
                comment: 'Disabled lore',
                content: 'Disabled lore',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
                enabled: false,
            },
            {
                id: 'legacy-id',
                key: 'legacy',
                secondkey: '',
                insertorder: 20,
                comment: 'Legacy lore',
                content: 'Legacy lore',
                mode: 'normal',
                alwaysActive: false,
                selective: false,
            },
        ]))

        expect(exported.data.character_book?.entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'Disabled lore', enabled: false }),
            expect.objectContaining({ name: 'Legacy lore', enabled: true }),
        ]))
    })

    test('preserves card lore metadata and unknown extensions through conversion', () => {
        const imported = convertCharbook({
            lorebook: [],
            charbook: {
                extensions: {},
                entries: [{
                    id: 42,
                    keys: ['archive'],
                    content: 'Archive lore',
                    extensions: {
                        custom_extension: { keep: true },
                        risu_activationPercent: 75,
                        risu_loreCache: { key: 'cache-key', data: ['cached'] },
                        risu_bookVersion: 2,
                    },
                    enabled: false,
                    insertion_order: 30,
                    name: 'Archive lore',
                    folder: 'archive-folder',
                } as never],
            },
            loresettings: undefined,
            loreExt: undefined,
        }).lorebook[0]

        expect(imported).toMatchObject({
            id: '42',
            enabled: false,
            activationPercent: 75,
            loreCache: { key: 'cache-key', data: ['cached'] },
            bookVersion: 2,
            folder: 'archive-folder',
            extentions: { custom_extension: { keep: true } },
        })

        const exported = createBaseV3(nativeCharacter([imported]))
        expect(exported.data.character_book?.entries[0]).toMatchObject({
            id: 42,
            enabled: false,
            folder: 'archive-folder',
            extensions: {
                custom_extension: { keep: true },
                risu_activationPercent: 75,
                risu_loreCache: { key: 'cache-key', data: ['cached'] },
                risu_bookVersion: 2,
            },
        })
    })

    function numericIdLore() {
        return {
            id: 42,
            key: 'numeric',
            secondkey: '',
            insertorder: 10,
            comment: 'Numeric ID lore',
            content: 'Numeric ID lore',
            mode: 'normal',
            alwaysActive: false,
            selective: false,
        } as never
    }

    test('normalizes numeric native IDs for V2 export', () => {
        expect(createBaseV2(nativeCharacter([numericIdLore()])).data.character_book?.entries[0]).toMatchObject({ id: 42 })
    })

    test('normalizes numeric native IDs for V3 export', () => {
        expect(createBaseV3(nativeCharacter([numericIdLore()])).data.character_book?.entries[0]).toMatchObject({ id: 42 })
    })

    test('normalizes numeric risu_id extensions on import', () => {
        const imported = convertCharbook({
            lorebook: [],
            charbook: {
                extensions: {},
                entries: [{
                    keys: ['numeric-extension'],
                    content: 'Numeric extension lore',
                    extensions: { risu_id: 73, unknown_extension: 'kept' },
                    enabled: true,
                    insertion_order: 10,
                } as never],
            },
            loresettings: undefined,
            loreExt: undefined,
        }).lorebook[0]

        expect(imported.id).toBe('73')
        expect(imported.extentions).toMatchObject({ unknown_extension: 'kept' })
    })
})
