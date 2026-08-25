import { buildPreparedRequest, resolveAdapterCredential, type AdapterCredential } from '../preset/adapter'
import { resolveWireModelId } from '../preset/adapter/wireInvariants'
import type { ModelPreset } from '../preset/types'

export type PageFoldPresetProvider = 'google' | 'vertex' | 'openrouter' | 'llmgateway'

export interface PageFoldPresetRouteOverride {
    activeProvider: PageFoldPresetProvider
    route: {
        apiKey?: string
        accessToken?: string
        authMode?: 'access_token'
        model: string
        baseUrl?: string
        headers?: Record<string, string>
    }
}

export interface PageFoldPresetSupport {
    supported: boolean
    provider?: PageFoldPresetProvider
    label?: string
    reason?: string
}

const SUPPORTED_PROVIDERS: Record<string, {
    provider: PageFoldPresetProvider
    label: string
    adapterKind: ModelPreset['profileSnapshot']['adapterKind']
    authKind: ModelPreset['profileSnapshot']['auth']['kind']
    endpointKind: ModelPreset['profileSnapshot']['endpoint']['kind']
}> = {
    google: {
        provider: 'google',
        label: 'Google AI Studio',
        adapterKind: 'google-gemini',
        authKind: 'x-goog-api-key',
        endpointKind: 'static',
    },
    'vertex-gemini-native': {
        provider: 'vertex',
        label: 'Vertex AI',
        adapterKind: 'google-gemini',
        authKind: 'google-service-account',
        endpointKind: 'vertex-gemini',
    },
    openrouter: {
        provider: 'openrouter',
        label: 'OpenRouter',
        adapterKind: 'openai-compatible',
        authKind: 'bearer',
        endpointKind: 'static',
    },
    llmgateway: {
        provider: 'llmgateway',
        label: 'LLM Gateway',
        adapterKind: 'openai-compatible',
        authKind: 'bearer',
        endpointKind: 'static',
    },
}

function requireStaticBaseUrl(preset: ModelPreset, provider: PageFoldPresetProvider): string {
    const endpoint = preset.profileSnapshot.endpoint
    if (endpoint.kind !== 'static' || !endpoint.url) {
        throw new Error(`${provider} PageFold requires a static endpoint URL.`)
    }
    const url = endpoint.url.replace(/\/+$/, '')
    if (provider === 'google') {
        if (!/\/models$/i.test(url)) throw new Error('Google PageFold endpoint must end with /models.')
        return url.replace(/\/models$/i, '')
    }
    if (!/\/chat\/completions$/i.test(url)) {
        throw new Error(`${provider} PageFold endpoint must end with /chat/completions.`)
    }
    return url.replace(/\/chat\/completions$/i, '')
}

export function getPageFoldPresetSupport(preset: ModelPreset | null | undefined): PageFoldPresetSupport {
    if (!preset?.profileSnapshot) return { supported: false, reason: 'No model profile is selected.' }
    const definition = SUPPORTED_PROVIDERS[preset.profileSnapshot.providerBaseId]
    if (!definition) {
        return {
            supported: false,
            reason: 'PageFold supports Google AI Studio, Vertex Gemini, OpenRouter and LLM Gateway presets.',
        }
    }
    if (preset.profileSnapshot.adapterKind !== definition.adapterKind
        || preset.profileSnapshot.auth.kind !== definition.authKind
        || preset.profileSnapshot.endpoint.kind !== definition.endpointKind) {
        return {
            supported: false,
            provider: definition.provider,
            label: definition.label,
            reason: `${definition.label} profile authentication or endpoint type is not compatible with PageFold.`,
        }
    }
    try {
        resolveWireModelId(preset, { vendorName: definition.label })
        if (definition.provider !== 'vertex') requireStaticBaseUrl(preset, definition.provider)
    } catch (error) {
        return {
            supported: false,
            provider: definition.provider,
            label: definition.label,
            reason: error instanceof Error ? error.message : String(error),
        }
    }
    return { supported: true, provider: definition.provider, label: definition.label }
}

export async function buildPageFoldPresetRoute(
    preset: ModelPreset,
    credential: AdapterCredential | undefined,
    abortSignal?: AbortSignal,
): Promise<PageFoldPresetRouteOverride> {
    const support = getPageFoldPresetSupport(preset)
    if (!support.supported || !support.provider) {
        throw new Error(support.reason ?? 'This model preset is not compatible with PageFold.')
    }
    const model = resolveWireModelId(preset, { vendorName: support.label ?? 'PageFold' })

    if (support.provider === 'vertex') {
        const serviceAccountJson = credential?.apiKey
        if (!serviceAccountJson) throw new Error('Vertex AI service account credential is missing from this preset.')
        const resolvedCredential = await resolveAdapterCredential({ preset, credential, abortSignal })
        if (!resolvedCredential?.apiKey) throw new Error('Vertex AI access token resolution failed.')
        const prepared = buildPreparedRequest({
            preset,
            credential: resolvedCredential,
            serviceAccountJson,
        })
        const baseUrl = prepared.url.replace(/\/+$/, '')
        if (!/\/publishers\/google\/models$/i.test(baseUrl)) {
            throw new Error('Vertex Gemini PageFold endpoint must end with /publishers/google/models.')
        }
        const sharedRequestType = Object.entries(prepared.headers).find(
            ([name]) => name.toLowerCase() === 'x-vertex-ai-llm-request-type',
        )?.[1]
        return {
            activeProvider: 'vertex',
            route: {
                // Service-account JSON never crosses the host/plugin boundary.
                authMode: 'access_token',
                accessToken: resolvedCredential.apiKey,
                model,
                baseUrl,
                ...(sharedRequestType
                    ? { headers: { 'X-Vertex-AI-LLM-Request-Type': sharedRequestType } }
                    : {}),
            },
        }
    }

    const apiKey = credential?.apiKey
    if (!apiKey) throw new Error(`${support.label ?? 'PageFold'} API key is missing from this preset.`)
    return {
        activeProvider: support.provider,
        route: {
            apiKey,
            model,
            baseUrl: requireStaticBaseUrl(preset, support.provider),
        },
    }
}
