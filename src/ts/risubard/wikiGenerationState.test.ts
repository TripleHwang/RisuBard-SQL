import { get } from 'svelte/store'
import { beforeEach, describe, expect, test } from 'vitest'
import {
    beginWikiGeneration,
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
})
