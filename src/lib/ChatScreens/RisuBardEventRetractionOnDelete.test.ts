import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const source = readFileSync(resolve(
    process.cwd(),
    'src/lib/ChatScreens/Chat.svelte'
), 'utf8')

describe('confirmed message deletion', () => {
    test('retracts linked wiki events before removing confirmed messages', () => {
        expect(source).toContain('retractWikiEventsBySourceMessages')
        expect(source).toContain('message?.risubardMemoryConfirmed === true')
        expect(source.indexOf('await retractWikiEventsBySourceMessages'))
            .toBeLessThan(source.indexOf('msg.splice(idx, 1)'))
    })
})

describe('confirmed message editing', () => {
    test('keeps the edit control available after BardWiki confirmation', () => {
        const editStart = source.indexOf('{#snippet translationButton')
        const editEnd = source.indexOf('{#snippet rerolls', editStart)
        const editControls = source.slice(editStart, editEnd)

        expect(editControls).toContain('button-icon-edit')
        expect(editControls).not.toContain('!memoryConfirmed')
        expect(editControls).toContain('&& !memoryConfirming')
    })
})
