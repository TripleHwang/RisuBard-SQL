import { describe, expect, test } from 'vitest'
import { createModelPresetRequestProvenance } from './modelProvenance'

function preset(overrides: Record<string, unknown> = {}) {
    return {
        name: 'Display preset name',
        userValues: { modelId: 'wire-override' },
        profileSnapshot: {
            modelId: 'snapshot-model',
            schema: [{ key: 'modelId', default: 'schema-default' }],
        },
        ...overrides,
    } as any
}

describe('createModelPresetRequestProvenance', () => {
    test('separates the exact adapter wire model from the display preset name', () => {
        expect(createModelPresetRequestProvenance(preset())).toEqual({
            wireModelId: 'wire-override',
            displayModel: 'Display preset name',
        })
    })

    test('falls back to the snapshot model when invalid persisted user input prevents wire resolution', () => {
        expect(createModelPresetRequestProvenance(preset({ userValues: { modelId: '' } })).wireModelId).toBe('snapshot-model')
    })

    test('uses the display name only when no snapshot model remains for malformed legacy data', () => {
        expect(createModelPresetRequestProvenance(preset({
            userValues: { modelId: '' },
            profileSnapshot: { modelId: '', schema: [{ key: 'modelId' }] },
        })).wireModelId).toBe('Display preset name')
    })

    test('provides a single request-boundary bundle for wire provenance and UI labels', () => {
        const provenance = createModelPresetRequestProvenance(preset())
        expect(provenance.wireModelId).toBe('wire-override')
        expect(provenance.displayModel).toBe('Display preset name')
    })
})
