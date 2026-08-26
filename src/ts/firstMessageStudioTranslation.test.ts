import { describe, expect, it } from 'vitest'
import { localizeStudioText, normalizeFirstMessageStudioProject } from './firstMessageStudio'
import {
    applyFirstMessageStudioTranslations,
    buildFirstMessageStudioTranslationPrompt,
    collectFirstMessageStudioTranslationEntries,
    parseFirstMessageStudioTranslations,
} from './firstMessageStudioTranslation'

function fixture() {
    return normalizeFirstMessageStudioProject({
        enabled: true,
        title: { ko: '설정', fr: '' },
        localization: {
            variable: 'ui_language',
            defaultLanguage: 'ko',
            languages: [
                { id: 'ko', label: '한국어', value: 'kr' },
                { id: 'fr', label: 'Français', value: 'fr' },
            ],
        },
        variables: [{ name: 'route', label: { ko: '경로', fr: '' }, defaultValue: '', choices: [
            { label: { ko: '평온', fr: '' }, value: 'calm' },
        ] }],
        stages: [{
            id: 'welcome',
            tag: { ko: '시작', fr: '' },
            title: { ko: '환영', fr: '' },
            description: { ko: '하나를 고르세요.', fr: '' },
            optionPresentationEnabled: true,
            options: [{
                id: 'calm',
                label: { ko: '평온하게', fr: '' },
                description: { ko: '조용한 시작', fr: '' },
                effects: [{ variable: 'route', value: 'machine-value' }],
                presentation: {
                    speaker: { ko: '마가렛', fr: '' },
                    description: { ko: '비가 내리는 평온한 오후입니다.', fr: '' },
                    imageEnabled: true,
                    imageFrame: 'contain',
                    imagePositionX: 50,
                    imagePositionY: 50,
                    imageAssetName: 'calm.webp',
                },
            }],
        }],
        scenarioRules: [{
            id: 'calm-intro',
            label: 'Calm intro',
            message: { ko: '평온한 이야기의 시작', fr: '' },
            groups: [{ id: 'route', conditions: [{ variable: 'route', operator: 'equals', value: 'calm' }] }],
        }],
    })
}

describe('first message studio AI translation', () => {
    it('collects only visible source strings and applies parsed translations by stable id', () => {
        const project = fixture()
        const entries = collectFirstMessageStudioTranslationEntries(project, 'ko')
        expect(entries.map((entry) => entry.text)).toContain('하나를 고르세요.')
        expect(entries.map((entry) => entry.text)).toContain('평온한 이야기의 시작')
        expect(entries.map((entry) => entry.text)).toContain('마가렛')
        expect(entries.map((entry) => entry.text)).toContain('비가 내리는 평온한 오후입니다.')
        expect(entries.map((entry) => entry.text)).not.toContain('machine-value')
        expect(entries.map((entry) => entry.text)).not.toContain('calm')
        expect(entries.map((entry) => entry.text)).not.toContain('calm.webp')

        const response = `\`\`\`json\n${JSON.stringify({
            translations: entries.map((entry) => ({ id: entry.id, text: `FR:${entry.text}` })),
        })}\n\`\`\``
        const translations = parseFirstMessageStudioTranslations(response, entries.map((entry) => entry.id))
        const translated = applyFirstMessageStudioTranslations(project, 'fr', translations)

        expect(localizeStudioText(translated.title, 'fr')).toBe('FR:설정')
        expect(localizeStudioText(translated.stages[0].description, 'fr')).toBe('FR:하나를 고르세요.')
        expect(localizeStudioText(translated.stages[0].options[0].presentation?.speaker, 'fr')).toBe('FR:마가렛')
        expect(localizeStudioText(translated.stages[0].options[0].presentation?.description, 'fr')).toBe('FR:비가 내리는 평온한 오후입니다.')
        expect(localizeStudioText(translated.scenarioRules[0].message, 'fr')).toBe('FR:평온한 이야기의 시작')
        expect(translated.stages[0].options[0].effects[0].value).toBe('machine-value')
    })

    it('builds a user-only prompt with an explicit JSON contract', () => {
        const entries = collectFirstMessageStudioTranslationEntries(fixture(), 'ko')
        const prompt = buildFirstMessageStudioTranslationPrompt(entries, '한국어', 'Français')
        expect(prompt).toContain('한국어')
        expect(prompt).toContain('Français')
        expect(prompt).toContain('translations')
        expect(prompt).toContain(entries[0].id)
    })

    it('rejects missing or unknown translation ids', () => {
        expect(() => parseFirstMessageStudioTranslations('{"translations":[]}', ['project.title'])).toThrow('translation-response-incomplete')
        expect(() => parseFirstMessageStudioTranslations('{"translations":[{"id":"other","text":"x"}]}', ['project.title'])).toThrow('translation-response-invalid')
    })
})
