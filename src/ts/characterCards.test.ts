import { describe, expect, test, vi } from 'vitest'
import type { character } from './storage/database.svelte'
import { convertCharbook, createBaseV2, createBaseV3, readFirstMessageStudioExtension } from './characterCards'
import { createBlankStudioProject } from './firstMessageStudio'
import { characterFormatUpdate } from './characters'

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
vi.mock('./process/inlayScreen', () => ({ updateInlayScreen: (char: character) => char }))

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

describe('first message studio character-card extension', () => {
    test('exports editable Studio source and generated Risu variables together in v2', () => {
        const project = createBlankStudioProject()
        project.fallbackMessage = 'Editable source'
        const card = createBaseV2({
            ...nativeCharacter([]),
            firstMessage: '<div data-first-message-studio-compatible></div>',
            firstMessageStudio: project,
            defaultVariables: 'first_message_studio_done=0',
        })

        expect(card.data.first_mes).toContain('data-first-message-studio-compatible')
        expect(card.data.extensions.risuai?.firstMessageStudio?.fallbackMessage).toBe('Editable source')
        expect(card.data.extensions.risuai?.defaultVariables).toBe('first_message_studio_done=0')
    })

    test('preserves a project through v3 export and import without sharing references', () => {
        const project = createBlankStudioProject()
        project.variables.push({
            name: 'route', label: 'Route', defaultValue: '', choices: [{ label: 'Calm', value: 'calm' }],
        })
        project.customCss = ':scope { border-width: 2px; }'
        const card = createBaseV3({
            ...nativeCharacter([]),
            firstMessageStudio: project,
        })

        const extension = card.data.extensions.risuai?.firstMessageStudio
        const imported = readFirstMessageStudioExtension(card.data)

        expect(extension).toEqual(project)
        expect(imported).toEqual(project)
        expect(imported).not.toBe(project)
        expect(imported?.stages).not.toBe(project.stages)
    })
})

describe('Risu character-card extensions', () => {
    test('exports post-history instructions separately from the Risu replace-global-note extension', () => {
        const source = {
            ...nativeCharacter([]),
            postHistoryInstructions: 'standard post-history instructions',
            replaceGlobalNote: 'Risu global-note replacement',
        }
        const exported = createBaseV3(source)

        expect(exported.data.post_history_instructions).toBe('standard post-history instructions')
        expect(exported.data.extensions.risuai?.replaceGlobalNote).toBe('Risu global-note replacement')
    })

    test('exports module namespace and hidden chat icon through v3 extensions', () => {
        const source = {
            ...nativeCharacter([]),
            moduleNamespace: 'test-namespace',
            hideChatIcon: true,
        }
        const exported = createBaseV3(source)

        expect(exported.data.extensions.risuai).toMatchObject({
            moduleNamespace: 'test-namespace',
            hideChatIcon: true,
        })
    })

    test('keeps post-history instructions for export after applying them only once', () => {
        const char = {
            ...nativeCharacter([]),
            chats: [{ message: [], note: '', name: 'Chat 1', localLore: [] }],
            chatPage: 0,
            postHistoryInstructions: 'apply once and preserve',
        }

        characterFormatUpdate(char)
        characterFormatUpdate(char)

        expect(char.chats[0].note).toBe('apply once and preserve')
        expect(char.postHistoryInstructions).toBe('apply once and preserve')
        expect(createBaseV3(char).data.post_history_instructions).toBe('apply once and preserve')
    })

    test('replaces an unchanged auto-applied post-history suffix when its value changes or clears', () => {
        const char = {
            ...nativeCharacter([]),
            chats: [{ message: [], note: 'existing note', name: 'Chat 1', localLore: [] }],
            chatPage: 0,
            postHistoryInstructions: 'first instruction',
        }

        characterFormatUpdate(char)
        char.postHistoryInstructions = 'second instruction'
        characterFormatUpdate(char)
        char.postHistoryInstructions = ''
        characterFormatUpdate(char)
        char.postHistoryInstructions = 'first instruction'
        characterFormatUpdate(char)

        expect(char.chats[0].note).toBe('existing note\nfirst instruction')
        expect(char.postHistoryInstructionsApplied).toBe('first instruction')
    })

    test('does not remove user-edited post-history note content while resetting its marker', () => {
        const char = {
            ...nativeCharacter([]),
            chats: [{ message: [], note: '', name: 'Chat 1', localLore: [] }],
            chatPage: 0,
            postHistoryInstructions: 'first instruction',
        }

        characterFormatUpdate(char)
        char.chats[0].note = 'first instruction (user edited)'
        char.postHistoryInstructions = ''
        characterFormatUpdate(char)

        expect(char.chats[0].note).toBe('first instruction (user edited)')
        expect(char.postHistoryInstructionsApplied).toBeUndefined()
    })
})
