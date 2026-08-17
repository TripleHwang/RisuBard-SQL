import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { shouldAutomaticallyConfirmNarrativeTurn } from './automaticWikiConfirmation'

describe('automatic BardWiki confirmation', () => {
    test('remains enabled for existing settings and can be disabled explicitly', () => {
        expect(shouldAutomaticallyConfirmNarrativeTurn(undefined)).toBe(true)
        expect(shouldAutomaticallyConfirmNarrativeTurn(true)).toBe(true)
        expect(shouldAutomaticallyConfirmNarrativeTurn(false)).toBe(false)
    })

    test('places a manual wiki button and auto switch after the send control', () => {
        const composer = readFileSync(
            'src/lib/ChatScreens/DefaultChatScreen.svelte',
            'utf8'
        )

        expect(composer).toContain('data-risubard-wiki-button')
        expect(composer).toContain('onclick={() => memoryWikiOpen = true}')
        expect(composer).toContain('data-risubard-auto-wiki')
        expect(composer).toContain('DBState.db.risuBardAutoWikiEnabled !== false')
    })

    test('guards only automatic confirmation and keeps manual confirmation available', () => {
        const processSource = readFileSync('src/ts/process/index.svelte.ts', 'utf8')

        expect(processSource).toMatch(
            /shouldAutomaticallyConfirmNarrativeTurn\(\s*DBState\.db\.risuBardAutoWikiEnabled\s*\)/
        )
        expect(processSource).toContain('export async function confirmCurrentNarrativeMessage(')
    })
})
