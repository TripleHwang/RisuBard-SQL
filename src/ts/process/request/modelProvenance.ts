import { resolveWireModelId } from 'src/ts/preset/adapter/wireInvariants'
import type { ModelPreset } from 'src/ts/preset/types'

/**
 * Telemetry must identify the model the adapter will put on the wire, while
 * response display remains owned by the preset name. A malformed saved preset
 * will be rejected by the adapter later; retain its snapshot model in logs so
 * that error is still attributable without changing that request behavior.
 */
export interface ModelPresetRequestProvenance {
    wireModelId: string
    displayModel: string
}

export function createModelPresetRequestProvenance(preset: ModelPreset): ModelPresetRequestProvenance {
    try {
        return { wireModelId: resolveWireModelId(preset), displayModel: preset.name }
    } catch {
        return {
            wireModelId: preset.profileSnapshot.modelId || preset.name,
            displayModel: preset.name,
        }
    }
}
