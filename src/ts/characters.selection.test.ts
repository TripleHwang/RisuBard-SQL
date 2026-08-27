import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const source = readFileSync('src/ts/characters.ts', 'utf8')
const activation = source.slice(source.indexOf('async function activateCharacter'))

describe('atomic character selection contract', () => {
    test('hydrates the character and bounded active chat before committing the selected ID', () => {
        const characterHydration = activation.indexOf('await ensureCharacterHydrated')
        const chatHydration = activation.indexOf('await ensureChatHydrated')
        const commit = activation.indexOf('selectedCharID.set(stableIndex)')

        expect(characterHydration).toBeGreaterThan(-1)
        expect(chatHydration).toBeGreaterThan(characterHydration)
        expect(commit).toBeGreaterThan(chatHydration)
        expect(activation).toContain('intent !== characterSelectionIntent')
        expect(activation).toContain("stableCharacter.chats[stableCharacter.chatPage]?.id !== activeChatId")
        expect(activation).not.toContain('loadFullChatHistory')
        const missingChat = activation.slice(activation.indexOf('if (!hydratedChat)'), activation.indexOf('const stableIndex'))
        expect(missingChat).toContain('intent !== characterSelectionIntent')
        expect(missingChat).toContain("throw new Error('Unable to load the selected chat. Please try again.')")
        const deferredSelection = source.slice(source.indexOf('export async function changeChar'), source.indexOf('/** Resumes the newest safe-shell selection'))
        expect(deferredSelection).toContain('onFailure: () =>')
        expect(deferredSelection).toContain('alertError(new Error(\'Unable to load the selected character. Please try again.\'))')
        const failureHandler = deferredSelection.slice(deferredSelection.indexOf('onFailure: () =>'), deferredSelection.indexOf('},\n    })'))
        expect(failureHandler).toContain('intent !== characterSelectionIntent')
        expect(failureHandler).toContain("loadingOverlayStore.set({ active: false, text: '', onCancel: null })")
    })
})
