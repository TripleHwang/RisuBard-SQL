import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { languageEnglish } from '../../lang/en'
import { languageKorean } from '../../lang/ko'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('character configuration navigation', () => {
    test('uses the requested Solar Bold icon mapping', () => {
        const config = source('src/lib/SideBars/CharConfig.svelte')
        const iconPath = 'src/lib/UI/Icons/SolarBoldIcon.svelte'
        expect(existsSync(resolve(process.cwd(), iconPath))).toBe(true)
        for (const name of [
            'people-nearby',
            'gallery-wide',
            'notebook',
            'microphone-3',
            'code-square',
            'settings',
            'share',
        ]) {
            expect(config).toContain(`<SolarBoldIcon name="${name}" size={iconButtonSize} />`)
            expect(source(iconPath)).toContain(`name === '${name}'`)
        }
        expect(config).not.toMatch(/<(UserIcon|SmileIcon|BookIcon|Volume2Icon|Braces|ActivityIcon|Share2Icon)/)
    })

    test('labels every icon tab and gives the final screen a Share heading', () => {
        const config = source('src/lib/SideBars/CharConfig.svelte')
        expect(config.match(/data-character-config-tab/g)).toHaveLength(7)
        expect(config).toContain('aria-label={language.share}')
        expect(config).toContain('>{language.share}</h2>')
        expect(languageEnglish.share).toBe('Share')
        expect(languageKorean.share).toBe('공유')
    })

    test('evenly distributes tabs with compact equal vertical spacing', () => {
        const config = source('src/lib/SideBars/CharConfig.svelte')
        expect(config).toContain('data-character-config-navigation')
        expect(config).toContain('class="flex w-full items-center justify-evenly my-1.5"')
        expect(config).not.toContain('class="flex mb-2"')
        expect(config).not.toContain('text-2xl font-bold mt-2')
    })

    test('shows the localized tab name in the app tooltip', () => {
        const config = source('src/lib/SideBars/CharConfig.svelte')
        expect(config).toContain('import { tooltip } from "src/ts/gui/tooltip";')
        expect(config.match(/use:tooltip=/g)).toHaveLength(7)
        for (const label of [
            'language.characterInfo',
            'language.characterDisplay',
            'language.loreBook',
            '"TTS"',
            'language.scripts',
            'language.advancedSettings',
            'language.share',
        ]) {
            expect(config).toContain(`use:tooltip={${label}}`)
        }
    })
})
