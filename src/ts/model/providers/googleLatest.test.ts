import { describe, expect, test } from 'vitest'
import { GoogleModels } from './google'

describe('latest Haejeok Google model compatibility', () => {
    test('includes Gemini Flash 3.7', () => {
        const model = GoogleModels.find(item => item.id === 'gemini-3.7-flash')
        expect(model).toBeDefined()
        expect(model?.recommended).toBe(true)
        expect(model?.parameters).toContain('reasoning_effort')
    })
})
