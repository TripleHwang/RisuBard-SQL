export const NOVEL_AI_IMAGE_MODELS = [
    'nai-diffusion-5-full',
    'nai-diffusion-5-curated',
    'nai-diffusion-4-5-full',
    'nai-diffusion-4-5-curated',
    'nai-diffusion-4-full',
    'nai-diffusion-4-curated-preview',
    'nai-diffusion-3',
    'nai-diffusion-furry-3',
    'nai-diffusion-2',
] as const

const isNovelAIImageV5 = (model: string) => model === 'nai-diffusion-5-full' || model === 'nai-diffusion-5-curated'

export const supportsNovelAIImageNoiseSchedule = (model: string) => !isNovelAIImageV5(model)

export const supportsNovelAIImageVibeTransfer = (model: string) => !isNovelAIImageV5(model)

export const sanitizeNovelAIImageParameters = <T extends Record<string, any>>(
    model: string,
    parameters: T,
): T => {
    if(!isNovelAIImageV5(model)){
        return parameters
    }

    const sanitized = {
        ...parameters,
        legacy_uc: false,
        normalize_reference_strength_multiple: false,
        v4_negative_prompt: parameters.v4_negative_prompt
            ? { ...parameters.v4_negative_prompt, legacy_uc: false }
            : parameters.v4_negative_prompt,
    } as T

    delete sanitized.noise_schedule
    delete sanitized.skip_cfg_above_sigma
    delete sanitized.reference_image_multiple
    delete sanitized.reference_strength_multiple
    delete sanitized.director_reference_images
    delete sanitized.director_reference_descriptions
    delete sanitized.director_reference_information_extracted
    delete sanitized.director_reference_strength_values

    return sanitized
}
