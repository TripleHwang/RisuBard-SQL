import { describe, expect, test } from 'vitest'
import {
    GPT5BaseParameters,
    GPT5NoneParameters,
    GPT5ProParameters,
    GPT5XHighParameters,
    OpenAIParameters,
} from '../types'
import { OpenAIModels } from './openai'

function parametersFor(internalID: string) {
    const model = OpenAIModels.find((entry) => entry.internalID === internalID)
    expect(model, `missing ${internalID}`).toBeDefined()
    return model!.parameters
}

describe('OpenAI model parameter capabilities', () => {
    test.each([
        ['gpt-5.1', GPT5NoneParameters],
        ['gpt-5.2', GPT5XHighParameters],
        ['gpt-5.4', GPT5XHighParameters],
        ['gpt-5.4-2026-03-05', GPT5XHighParameters],
        ['gpt-5.4-pro', GPT5ProParameters],
        ['gpt-5.4-pro-2026-03-05', GPT5ProParameters],
        ['gpt-5', GPT5BaseParameters],
    ])('%s exposes the expected reasoning capability set', (internalID, expected) => {
        expect(parametersFor(internalID)).toEqual(expected)
    })

    test.each(['gpt-5-chat-latest', 'gpt-5.1-chat-latest', 'gpt-5.2-chat-latest'])(
        '%s remains a non-reasoning chat model',
        (internalID) => expect(parametersFor(internalID)).toEqual(OpenAIParameters),
    )
})
