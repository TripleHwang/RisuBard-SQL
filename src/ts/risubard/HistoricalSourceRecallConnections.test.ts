import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

describe('historical source recall connections', () => {
    test('searches loaded history outside the response rolling window', () => {
        const source = readFileSync(resolve(
            process.cwd(),
            'src/ts/process/index.svelte.ts'
        ), 'utf8')
        const recallCall = source.match(
            /sourceMatches: findHistoricalSourceMatches\(\{[\s\S]{0,500}?\}\),/
        )?.[0] ?? ''

        expect(source).toContain(
            "import { findHistoricalSourceMatches } from '../risubard/historicalSourceRecall'"
        )
        expect(recallCall).toContain('messages: currentChat.message')
        expect(recallCall).toContain(
            'inquirySettings.risuBardResponseMessageCount'
        )
        expect(recallCall).not.toContain(
            'inquirySettings.risuBardRecentMessageCount'
        )
    })
})
