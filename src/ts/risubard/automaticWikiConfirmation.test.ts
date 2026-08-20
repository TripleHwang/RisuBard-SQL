import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { shouldAutomaticallyConfirmNarrativeTurn } from './automaticWikiConfirmation'

describe('automatic BardWiki confirmation', () => {
    test('cannot be disabled by a legacy stored setting', () => {
        expect(shouldAutomaticallyConfirmNarrativeTurn()).toBe(true)
    })

    test('places only the manual wiki button after the send control', () => {
        const composer = readFileSync(
            'src/lib/ChatScreens/DefaultChatScreen.svelte',
            'utf8'
        )

        expect(composer).toContain('data-risubard-wiki-button')
        expect(composer).toContain('onclick={() => memoryWikiOpen = true}')
        expect(composer).not.toContain('data-risubard-auto-wiki')
        expect(composer).not.toContain('DBState.db.risuBardAutoWikiEnabled')
    })

    test('always confirms automatically and keeps manual confirmation available', () => {
        const processSource = readFileSync('src/ts/process/index.svelte.ts', 'utf8')

        expect(processSource).toContain('shouldAutomaticallyConfirmNarrativeTurn()')
        expect(processSource).not.toContain(
            'shouldAutomaticallyConfirmNarrativeTurn(\n            DBState.db.risuBardAutoWikiEnabled'
        )
        expect(processSource).toContain('export async function confirmCurrentNarrativeMessage(')
    })
})
