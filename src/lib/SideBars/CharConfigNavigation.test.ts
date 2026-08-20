import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { languageEnglish } from '../../lang/en'
import { languageKorean } from '../../lang/ko'

const source = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8')

describe('character configuration navigation', () => {
    test('keeps character navigation in the shared sidebar toolbar', () => {
        const config = source('src/lib/SideBars/CharConfig.svelte')
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const iconPath = 'src/lib/UI/Icons/SolarBoldIcon.svelte'
        expect(existsSync(resolve(process.cwd(), iconPath))).toBe(true)
        for (const name of [
            'chat-round-dots',
            'people-nearby',
            'gallery-wide',
            'notebook',
            'microphone-3',
            'code-square',
            'settings',
        ]) {
            expect(sidebar).toContain(`<SolarBoldIcon name="${name}"`)
            expect(source(iconPath)).toContain(`name === '${name}'`)
        }
        expect(config).not.toContain('data-character-config-navigation')
    })

    test('puts chat home first and promotes character management to the title row', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('data-character-workspace-header')
        expect(sidebar).toContain('data-character-title')
        expect(sidebar).toContain('data-character-manage')
        expect(sidebar).toContain('data-character-config-navigation')
        expect(sidebar.indexOf('data-character-chat-home'))
            .toBeLessThan(sidebar.indexOf('data-character-config-tab'))
        expect(sidebar).not.toContain('data-sidebar-mode-tabs')
    })

    test('retains every character section from information through advanced settings', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar.match(/data-character-config-tab/g)).toHaveLength(6)
        for (const label of [
            'language.characterInfo',
            'language.characterDisplay',
            'language.loreBook',
            '"TTS"',
            'language.scripts',
            'language.advancedSettings',
        ]) {
            expect(sidebar).toContain(`aria-label={${label}}`)
        }
    })

    test('opens the former share screen from the management button', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const charConfig = source('src/lib/SideBars/CharConfig.svelte')
        const manageStart = sidebar.indexOf('data-character-manage')
        const manageEnd = sidebar.indexOf('</button>', manageStart)
        const manageButton = sidebar.slice(manageStart, manageEnd)
        expect(manageButton).toContain('characterManageOpen = true')
        expect(manageButton).not.toContain('botMakerMode.set(true)')
        expect(sidebar).toContain('bind:open={characterManageOpen}')
        expect(sidebar).toContain('closeOnOutsideClick={true}')
        expect(sidebar).toContain('<CharConfig subMenuOverride={6}')
        expect(charConfig).toContain('subMenuOverride?: number')
        expect(languageEnglish.share).toBe('Share')
        expect(languageKorean.share).toBe('공유')
    })

    test('closes character management safely when deletion clears the selection', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const charConfig = source('src/lib/SideBars/CharConfig.svelte')
        expect(sidebar).toMatch(/if \(\$selectedCharID < 0\)\s+characterManageOpen = false/)
        expect(charConfig).toContain('let currentCharacter = $derived(DBState.db.characters[$selectedCharID])')
        expect(charConfig).toContain('{#if currentCharacter}')
        expect(charConfig.match(/if \(!currentCharacter\) return/g)?.length).toBeGreaterThanOrEqual(9)
    })

    test('does not show trashed characters in recent or mobile character lists', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const mobileCharacters = source('src/lib/Mobile/MobileCharacters.svelte')
        expect(sidebar).toContain('.filter((c) => !c.trashTime)')
        expect(mobileCharacters).toContain('.filter((c) => !c.trashTime)')
        const recentChars = sidebar.slice(sidebar.indexOf('let recentChars'), sidebar.indexOf('let recentVisible'))
        const sortChar = mobileCharacters.slice(mobileCharacters.indexOf('function sortChar'), mobileCharacters.indexOf('</script>'))
        expect(recentChars.indexOf('.map(')).toBeLessThan(recentChars.indexOf('.filter('))
        expect(sortChar.indexOf('.map(')).toBeLessThan(sortChar.indexOf('.filter('))
    })

    test('uses the requested local Solar icons for management and developer tools', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        for (const [name, asset] of [
            ['share-bold', 'src/assets/solar-bold/share-bold.svg'],
            ['magnifier-bug-bold', 'src/assets/solar-bold/magnifier-bug-bold.svg'],
        ]) {
            expect(existsSync(resolve(process.cwd(), asset))).toBe(true)
            expect(sidebar).toContain(`name="${name}"`)
        }
        expect(sidebar).not.toContain('<WrenchIcon')
    })

    test('shares one toolbar button state model while chat keeps a visible idle state', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const styles = source('src/styles.css')
        expect(sidebar).toContain('character-toolbar-button--chat')
        expect(sidebar.match(/character-toolbar-button/g)?.length).toBeGreaterThanOrEqual(7)
        expect(sidebar).toContain("class:is-active={!$botMakerMode && !devTool}")
        expect(sidebar).toContain("class:is-active={$botMakerMode && !devTool && $CharConfigSubMenu === 0}")
        expect(styles).toContain('.character-toolbar-button--chat:not(.is-active)')
        expect(styles).toContain('.character-toolbar-button.is-active')
        expect(styles).toContain('transform: translateY(-1px)')
    })

    test('uses one vertical gap around the character toolbar and following heading', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const chatList = source('src/lib/SideBars/SideChatList.svelte')
        expect(sidebar).toMatch(
            /data-character-config-navigation[^>]*class="my-2 /
        )
        expect(chatList).toContain(
            '<section data-current-chat-section class="border-b border-darkborderc pb-2">'
        )
        expect(chatList).not.toContain('<section class="mt-1 border-b')
    })
})
