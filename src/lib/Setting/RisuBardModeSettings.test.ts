import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { normalizeNarrativeWorkingMessageLimit } from 'src/ts/risubard/narrativeContext'

const chatPagePath = resolve(process.cwd(), 'src/lib/Setting/Pages/RisuBardChatSettings.svelte')
const commonPagePath = resolve(process.cwd(), 'src/lib/Setting/Pages/RisuBardCommonSettings.svelte')
const memoryWikiPath = resolve(process.cwd(), 'src/lib/Others/RisuBardMemoryWiki.svelte')
const chatPage = existsSync(chatPagePath) ? readFileSync(chatPagePath, 'utf8') : ''
const commonPage = existsSync(commonPagePath) ? readFileSync(commonPagePath, 'utf8') : ''
const memoryWiki = readFileSync(memoryWikiPath, 'utf8')
const workspace = readFileSync(
    resolve(process.cwd(), 'src/lib/Setting/Settings.svelte'),
    'utf8',
)
const displaySettings = readFileSync(
    resolve(process.cwd(), 'src/ts/setting/displaySettingsData.svelte.ts'),
    'utf8',
)
const processSource = readFileSync(
    resolve(process.cwd(), 'src/ts/process/index.svelte.ts'),
    'utf8',
)
const databaseSource = readFileSync(
    resolve(process.cwd(), 'src/ts/storage/database.svelte.ts'),
    'utf8',
)

describe('RisuBard mode settings', () => {
    test('persists dedicated wiki prompt presets and scoped guide injections', () => {
        expect(databaseSource).toContain('risuBardWikiPromptPresets?:')
        expect(databaseSource).toContain('risuBardChatWikiPromptPresetId?: string')
        expect(databaseSource).toContain('risuBardWikiGuide?: string')
        expect(databaseSource).toContain('normalizeWikiPromptPresetState({')
        expect(databaseSource).toContain("typeof c.risuBardWikiGuide !== 'string'")
        expect(processSource).toContain('compileWikiPromptGuide(')
        expect(processSource).toContain("characterGuide: risuChatParser(character?.risuBardWikiGuide ?? ''")
        expect(processSource).toContain("chatGuide: risuChatParser(chat?.risuBardWikiGuide ?? ''")
    })

    test('keeps twelve recent messages as the default', () => {
        expect(normalizeNarrativeWorkingMessageLimit(undefined)).toBe(12)
    })

    test('keeps chat analysis and response-history controls together', () => {
        expect(chatPage).toContain("bindKey: 'risuBardRecentMessageCount'")
        expect(chatPage).toContain("bindKey: 'risuBardResponseMessageCount'")
        expect(chatPage).toContain("bindKey: 'risuBardResponseExcludeUserMessages'")
        expect(processSource).toContain(
            'DBState.db.risuBardResponseExcludeUserMessages !== true'
        )
        expect(chatPage).toContain('min: 1')
        expect(chatPage).toContain('max: 100')
        expect(memoryWiki).not.toContain('data-memory-recent-message-count')
        expect(memoryWiki).not.toContain('data-response-recent-message-count')
        expect(memoryWiki).not.toContain('data-response-include-user-messages')
    })

    test('exposes bounded automatic canon analysis controls without review mode', () => {
        expect(chatPage).toContain("id: 'risubard.chat.inquiryTargetTokenBudget'")
        expect(chatPage).toContain("id: 'risubard.chat.inquiryMaximumTokenBudget'")
        expect(chatPage).toContain('risuBardInquiryTargetTokenBudget')
        expect(chatPage).toContain('risuBardInquiryMaximumTokenBudget')
        expect(chatPage).toContain("bindKey: 'risuBardAnalysisTokenLimit'")
        expect(chatPage).toContain("bindKey: 'risuBardAdditionalSearchLimit'")
        expect(chatPage).toContain("bindKey: 'risuBardCanonicalTargetLimit'")
        expect(chatPage).not.toContain("bindKey: 'risuBardCanonicalMode'")
        expect(memoryWiki).not.toContain('RisuBardCanonicalAudit')
        expect(memoryWiki).not.toContain('unreviewedCount')
    })

    test('places the request context notification toggle in RisuBard chat settings', () => {
        expect(chatPage).toContain("bindKey: 'showRequestStatus'")
        expect(chatPage).toContain("id: 'risubard.chat.showRequestStatus'")
        expect(displaySettings).not.toContain("id: 'display.showRequestStatus'")
    })

    test('renders dedicated RisuBard chat settings routes', () => {
        expect(workspace).toContain('SettingsRoute.RisuBardCommon')
        expect(workspace).toContain('SettingsRoute.RisuBardChat')
        expect(workspace).toContain('<RisuBardCommonSettings />')
        expect(workspace).toContain('<RisuBardChatSettings />')
    })

    test('exposes one shared canonical writing style page', () => {
        expect(commonPage).toContain('risuBardCommonSettingsItems')
        expect(databaseSource).toContain('risuBardCanonicalWritingStyle?:')
        expect(databaseSource).toContain('risuBardCanonicalCustomStyle?: string')
        const settingsDataPath = resolve(
            process.cwd(),
            'src/ts/setting/risuBardCommonSettingsData.ts',
        )
        const settingsData = existsSync(settingsDataPath)
            ? readFileSync(settingsDataPath, 'utf8')
            : ''
        expect(settingsData).toContain("bindKey: 'risuBardCanonicalWritingStyle'")
        expect(settingsData).toContain("value: 'standard'")
        expect(settingsData).toContain("value: 'concise'")
        expect(settingsData).toContain("value: 'ultra-concise'")
        expect(settingsData).toContain("value: 'custom'")
        expect(settingsData).toContain("bindKey: 'risuBardCanonicalCustomStyle'")
        expect(settingsData).toContain("db.risuBardCanonicalWritingStyle === 'custom'")
        expect(settingsData).toContain('normalizeRisuBardCanonicalCustomStyle(value)')
    })

})
