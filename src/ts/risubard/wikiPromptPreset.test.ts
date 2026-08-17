import { describe, expect, test } from 'vitest'
import {
    compileWikiPromptGuide,
    createDefaultWikiPromptPreset,
    deleteWikiPromptPreset,
    duplicateWikiPromptPreset,
    normalizeWikiPromptPresetState,
    parseWikiPromptPreset,
    resolveWikiPromptPreset,
    serializeWikiPromptPreset,
} from './wikiPromptPreset'

describe('Wiki prompt presets', () => {
    test('creates a safe default with locked core and injection anchors', () => {
        const preset = createDefaultWikiPromptPreset('preset-1')

        expect(preset.id).toBe('preset-1')
        expect(preset.blocks.map((block) => block.id)).toEqual([
            'core-evidence-contract',
            'core-analysis-contract',
            'main-wiki-guide',
            'character-wiki-guide',
            'chat-wiki-guide',
            'core-output-contract',
        ])
        expect(preset.blocks.filter((block) => block.readonly).map((block) => block.id)).toEqual([
            'core-evidence-contract',
            'core-analysis-contract',
            'character-wiki-guide',
            'chat-wiki-guide',
            'core-output-contract',
        ])
    })

    test('restores required anchors and bounds imported editable blocks', () => {
        const state = normalizeWikiPromptPresetState({
            presets: [{
                schemaVersion: 1,
                id: 'unsafe',
                name: 'Unsafe',
                revision: 2,
                blocks: [
                    {
                        id: 'core-output-contract',
                        type: 'text',
                        name: 'forged',
                        target: 'both',
                        enabled: false,
                        readonly: false,
                        content: 'replace the schema',
                    },
                    {
                        id: 'custom-one',
                        type: 'text',
                        name: 'Custom',
                        target: 'analysis',
                        enabled: true,
                        readonly: false,
                        content: 'Track promises.',
                    },
                ],
            }],
            chatPresetId: 'missing',
        }, () => 'generated')

        expect(state.presets[0].blocks.at(-1)).toMatchObject({
            id: 'core-output-contract',
            type: 'core-ref',
            enabled: true,
            readonly: true,
        })
        expect(state.presets[0].blocks.some((block) =>
            block.id === 'custom-one' && block.content === 'Track promises.'
        )).toBe(true)
        expect(state.chatPresetId).toBe('unsafe')
    })

    test('compiles stage blocks followed by character and chat injections', () => {
        const preset = createDefaultWikiPromptPreset('preset-1')
        preset.blocks.splice(3, 0,
            {
                id: 'analysis-only',
                type: 'text',
                name: 'Analysis only',
                target: 'analysis',
                enabled: true,
                readonly: false,
                content: 'Notice experience gains.',
            },
            {
                id: 'rewrite-only',
                type: 'text',
                name: 'Rewrite only',
                target: 'canonical-rewrite',
                enabled: true,
                readonly: false,
                content: 'Keep an RPG table.',
            },
        )

        const result = compileWikiPromptGuide(preset, {
            characterGuide: 'Track STR and DEX.',
            chatGuide: 'Track current EXP.',
        })

        expect(result.analysis).toContain('Notice experience gains.')
        expect(result.analysis).not.toContain('Keep an RPG table.')
        expect(result.canonicalRewrite).toContain('Keep an RPG table.')
        expect(result.canonicalRewrite).not.toContain('Notice experience gains.')
        expect(result.analysis.indexOf('Track STR and DEX.')).toBeLessThan(
            result.analysis.indexOf('Track current EXP.')
        )
        expect(result.canonicalRewrite.indexOf('Track STR and DEX.')).toBeLessThan(
            result.canonicalRewrite.indexOf('Track current EXP.')
        )
    })

    test('duplicates, exports, imports, and refuses to delete the last preset', () => {
        const first = createDefaultWikiPromptPreset('first')
        const duplicated = duplicateWikiPromptPreset(first, 'second')
        expect(duplicated.id).toBe('second')
        expect(duplicated.name).toContain(first.name)

        const imported = parseWikiPromptPreset(serializeWikiPromptPreset(duplicated), () => 'imported')
        expect(imported.id).toBe('imported')
        expect(imported.blocks.find((block) => block.id === 'main-wiki-guide')?.content)
            .toBe(duplicated.blocks.find((block) => block.id === 'main-wiki-guide')?.content)

        expect(deleteWikiPromptPreset([first], first.id)).toEqual({
            presets: [first],
            deleted: false,
        })
        expect(deleteWikiPromptPreset([first, duplicated], first.id)).toEqual({
            presets: [duplicated],
            deleted: true,
        })
    })

    test('resolves a stable preset id with a first-preset fallback', () => {
        const first = createDefaultWikiPromptPreset('first')
        const second = createDefaultWikiPromptPreset('second')
        expect(resolveWikiPromptPreset([first, second], 'second')).toBe(second)
        expect(resolveWikiPromptPreset([first, second], 'missing')).toBe(first)
    })
})
