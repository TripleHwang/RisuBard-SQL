import { get } from 'svelte/store'
import { beforeEach, describe, expect, test } from 'vitest'
import {
    beginWikiGeneration,
    cancelWikiGeneration,
    endWikiGeneration,
    isWikiGenerating,
    resetWikiGenerationState,
    wikiGenerationOperations,
} from './wikiGenerationState'

describe('BardWiki generation activity', () => {
    beforeEach(resetWikiGenerationState)

    test('stays active until every distinct operation ends', () => {
        beginWikiGeneration('automatic:chat')
        beginWikiGeneration('reboot:chat')
        beginWikiGeneration('automatic:chat')
        expect(get(isWikiGenerating)).toBe(true)
        expect([...get(wikiGenerationOperations)]).toEqual([
            'automatic:chat', 'reboot:chat',
        ])
        endWikiGeneration('automatic:chat')
        expect(get(isWikiGenerating)).toBe(true)
        endWikiGeneration('reboot:chat')
        expect(get(isWikiGenerating)).toBe(false)
    })

    test('aborts every active operation and waits for their cleanup', () => {
        const automatic = beginWikiGeneration('automatic:chat')
        const command = beginWikiGeneration('command:chat')

        cancelWikiGeneration()

        expect(automatic.aborted).toBe(true)
        expect(command.aborted).toBe(true)
        expect(get(isWikiGenerating)).toBe(true)
        endWikiGeneration('automatic:chat')
        endWikiGeneration('command:chat')
        expect(get(isWikiGenerating)).toBe(false)
    })
})
