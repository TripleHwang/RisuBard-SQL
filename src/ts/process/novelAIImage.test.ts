import { describe, expect, test } from 'vitest'
import {
    NOVEL_AI_IMAGE_MODELS,
    sanitizeNovelAIImageParameters,
    supportsNovelAIImageNoiseSchedule,
    supportsNovelAIImageVibeTransfer,
} from './novelAIImage'

describe('NovelAI Diffusion V5 image support', () => {
    test('lists both V5 production models first', () => {
        expect(NOVEL_AI_IMAGE_MODELS[0]).toBe('nai-diffusion-5-full')
        expect(NOVEL_AI_IMAGE_MODELS[1]).toBe('nai-diffusion-5-curated')
    })

    test('disables unsupported V5 settings without changing V4.5 capabilities', () => {
        expect(supportsNovelAIImageNoiseSchedule('nai-diffusion-5-full')).toBe(false)
        expect(supportsNovelAIImageVibeTransfer('nai-diffusion-5-full')).toBe(false)
        expect(supportsNovelAIImageNoiseSchedule('nai-diffusion-5-curated')).toBe(false)
        expect(supportsNovelAIImageVibeTransfer('nai-diffusion-5-curated')).toBe(false)
        expect(supportsNovelAIImageNoiseSchedule('nai-diffusion-4-5-full')).toBe(true)
        expect(supportsNovelAIImageVibeTransfer('nai-diffusion-4-5-full')).toBe(true)
    })

    test('removes unsupported parameters from V5 requests', () => {
        const parameters = {
            noise_schedule: 'karras',
            skip_cfg_above_sigma: 58,
            legacy_uc: true,
            normalize_reference_strength_multiple: true,
            reference_image_multiple: ['vibe'],
            reference_strength_multiple: [0.7],
            director_reference_images: ['character'],
            director_reference_descriptions: [{ caption: {} }],
            director_reference_information_extracted: [1],
            director_reference_strength_values: [1],
            v4_negative_prompt: {
                caption: { base_caption: 'lowres', char_captions: [] },
                legacy_uc: true,
            },
            cfg_rescale: 0,
        }

        const result = sanitizeNovelAIImageParameters('nai-diffusion-5-full', parameters)

        expect(result).not.toHaveProperty('noise_schedule')
        expect(result).not.toHaveProperty('skip_cfg_above_sigma')
        expect(result).not.toHaveProperty('reference_image_multiple')
        expect(result).not.toHaveProperty('reference_strength_multiple')
        expect(result).not.toHaveProperty('director_reference_images')
        expect(result).not.toHaveProperty('director_reference_descriptions')
        expect(result).not.toHaveProperty('director_reference_information_extracted')
        expect(result).not.toHaveProperty('director_reference_strength_values')
        expect(result.legacy_uc).toBe(false)
        expect(result.normalize_reference_strength_multiple).toBe(false)
        expect(result.v4_negative_prompt.legacy_uc).toBe(false)
        expect(result.cfg_rescale).toBe(0)
        expect(parameters.noise_schedule).toBe('karras')
    })
})
