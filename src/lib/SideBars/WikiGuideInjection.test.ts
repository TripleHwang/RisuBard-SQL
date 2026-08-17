import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(
    resolve(process.cwd(), 'src/lib/SideBars/CharConfig.svelte'),
    'utf8'
)

describe('Wiki Guide sidebar injections', () => {
    test('edits character and current-chat guides independently near the author note', () => {
        expect(source).toContain('language.risuBardWikiPrompt.characterGuide')
        expect(source).toContain('language.risuBardWikiPrompt.chatGuide')
        expect(source).toContain('bind:value={DBState.db.characters[$selectedCharID].risuBardWikiGuide}')
        expect(source).toContain('chats[DBState.db.characters[$selectedCharID].chatPage].risuBardWikiGuide')
        expect(source).toContain('data-wiki-guide-injection')
    })
})
