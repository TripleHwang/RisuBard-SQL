import { describe, expect, test, vi } from 'vitest'
import type { ModelPreset } from '../preset/types'

vi.mock('../preset/adapter', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../preset/adapter')>()
    return {
        ...actual,
        resolveAdapterCredential: vi.fn(async ({ preset, credential }) =>
            preset.profileSnapshot.auth.kind === 'google-service-account'
                ? { apiKey: 'short-lived-vertex-token' }
                : credential
        ),
    }
})

import { buildPageFoldPresetRoute, getPageFoldPresetSupport } from './pageFoldPresetRoute'

function makePreset(overrides: Partial<ModelPreset> = {}): ModelPreset {
    return {
        id: 'preset',
        name: 'Preset',
        profileSnapshot: {
            profileId: 'google-test',
            profileVersion: 1,
            providerBaseId: 'google',
            providerBaseVersion: 1,
            adapterKind: 'google-gemini',
            auth: { kind: 'x-goog-api-key' },
            endpoint: { kind: 'static', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
            modelId: 'gemini-default',
            schema: [
                { key: 'apiKey', type: 'string', label: 'API key', mapsTo: { target: 'auth', path: 'apiKey' } },
                { key: 'modelId', type: 'string', label: 'Model', default: 'gemini-default', mapsTo: { target: 'body', path: 'model' } },
            ],
            uiSchema: { groups: [], fields: [] },
            defaults: {},
        },
        userValues: { modelId: 'gemini-selected' },
        createdAt: 1,
        updatedAt: 1,
        ...overrides,
    }
}

describe('PageFold ModelPreset route', () => {
    test('uses the Google preset model, endpoint and request-scoped credential', async () => {
        const route = await buildPageFoldPresetRoute(makePreset(), { apiKey: 'preset-key' })
        expect(route).toEqual({
            activeProvider: 'google',
            route: {
                apiKey: 'preset-key',
                model: 'gemini-selected',
                baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
            },
        })
    })

    test.each([
        ['openrouter', 'openrouter', 'https://openrouter.ai/api/v1/chat/completions', 'https://openrouter.ai/api/v1'],
        ['llmgateway', 'llmgateway', 'https://api.llmgateway.io/v1/chat/completions', 'https://api.llmgateway.io/v1'],
    ] as const)('maps %s without falling back to PageFold global routing', async (baseId, provider, endpoint, baseUrl) => {
        const preset = makePreset({
            profileSnapshot: {
                ...makePreset().profileSnapshot,
                providerBaseId: baseId,
                adapterKind: 'openai-compatible',
                auth: { kind: 'bearer' },
                endpoint: { kind: 'static', url: endpoint },
            },
        })
        await expect(buildPageFoldPresetRoute(preset, { apiKey: 'route-key' })).resolves.toEqual({
            activeProvider: provider,
            route: { apiKey: 'route-key', model: 'gemini-selected', baseUrl },
        })
    })

    test('exchanges Vertex service-account JSON on the host and passes only a short-lived token', async () => {
        const preset = makePreset({
            profileSnapshot: {
                ...makePreset().profileSnapshot,
                providerBaseId: 'vertex-gemini-native',
                adapterKind: 'google-gemini',
                auth: { kind: 'google-service-account' },
                endpoint: { kind: 'vertex-gemini' },
                headerTemplate: { 'X-Vertex-AI-LLM-Request-Type': 'shared' },
                schema: [
                    { key: 'modelId', type: 'string', label: 'Model', default: 'gemini-default', mapsTo: { target: 'body', path: 'model' } },
                    { key: 'projectId', type: 'string', label: 'Project', mapsTo: { target: 'custom', path: 'project' } },
                    { key: 'location', type: 'string', label: 'Location', default: 'global', mapsTo: { target: 'custom', path: 'location' } },
                ],
            },
            userValues: { modelId: 'gemini-selected', location: 'global' },
        })
        const serviceAccount = JSON.stringify({ project_id: 'preset-project', private_key: 'never-forward' })
        const route = await buildPageFoldPresetRoute(preset, { apiKey: serviceAccount })

        expect(route).toEqual({
            activeProvider: 'vertex',
            route: {
                authMode: 'access_token',
                accessToken: 'short-lived-vertex-token',
                model: 'gemini-selected',
                baseUrl: 'https://aiplatform.googleapis.com/v1/projects/preset-project/locations/global/publishers/google/models',
                headers: { 'X-Vertex-AI-LLM-Request-Type': 'shared' },
            },
        })
        expect(JSON.stringify(route)).not.toContain('never-forward')
    })

    test('rejects incompatible providers and malformed endpoint shapes', () => {
        expect(getPageFoldPresetSupport(makePreset({
            profileSnapshot: { ...makePreset().profileSnapshot, providerBaseId: 'anthropic' },
        })).supported).toBe(false)
        expect(getPageFoldPresetSupport(makePreset({
            profileSnapshot: {
                ...makePreset().profileSnapshot,
                endpoint: { kind: 'static', url: 'https://example.invalid/not-models' },
            },
        })).supported).toBe(false)
    })
})
