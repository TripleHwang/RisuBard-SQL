import { describe, expect, it, vi } from 'vitest'

const pluginModels = vi.hoisted(() => [] as any[])

vi.mock('../storage/database.svelte', () => ({ getDatabase: () => ({ enableCustomFlags: false, customModels: [] }) }))
vi.mock('../stores.svelte', () => ({ DBState: { db: { dynamicModelRegistry: false } } }))
vi.mock('../globalApi.svelte', () => ({ fetchNative: vi.fn() }))
vi.mock('../plugins/plugins.svelte', () => ({ customProviderStore: [], pluginV2: [] }))
vi.mock('../plugins/apiV3/v3.svelte', () => ({ customV3ProviderMetaStore: pluginModels }))

import { getModelList, LLMModels } from './modellist'
import { LLMFormat, LLMProvider, LLMTokenizer, type LLMModel } from './types'

describe('getModelList', () => {
    it('does not append plugin models to the canonical LLMModels array', () => {
        const plugin: LLMModel = {
            id: 'pluginmodel:::test', name: 'Test plugin', provider: LLMProvider.AsIs,
            format: LLMFormat.OpenAICompatible, flags: [], parameters: [], tokenizer: LLMTokenizer.Unknown
        }
        const baselineLength = LLMModels.length
        pluginModels.push(plugin)

        try {
            const first = getModelList({ groupedByProvider: false })
            const second = getModelList({ groupedByProvider: false })
            expect(first.filter((model) => model.id === plugin.id)).toHaveLength(1)
            expect(second.filter((model) => model.id === plugin.id)).toHaveLength(1)
            expect(LLMModels).toHaveLength(baselineLength)
            expect(LLMModels.some((model) => model.id === plugin.id)).toBe(false)
        } finally {
            pluginModels.splice(pluginModels.indexOf(plugin), 1)
        }
    })
})
