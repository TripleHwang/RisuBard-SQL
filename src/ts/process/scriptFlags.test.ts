import { describe, expect, it } from 'vitest'
import {
    defaultScriptFlag,
    findUnknownScriptFlagActions,
    getScriptFlagTags,
    normalizeScriptFlag,
    scriptFlagContains,
    stripScriptFlagTags,
    toggleScriptFlag,
    tryCompileScriptRegex,
} from './scriptFlags'

// The two toggle rows the flag editor actually renders (RegexData.svelte).
const letterFlags = ['g', 'i', 'm', 'u', 's']
const actionTags = ['<move_top>', '<move_bottom>', '<repeat_back>', '<cbs>', '<no_end_nl>']

describe('normalizeScriptFlag', () => {
    it('never invents the u flag when the flag is emptied out', () => {
        // Whitespace around an action tag is all that survives the tag strip,
        // and 'u' rejects patterns that are legal everywhere else.
        for (const emptied of ['', ' ', '  ', '\t', '\n']) {
            expect(normalizeScriptFlag(emptied)).toBe('g')
        }
        expect(normalizeScriptFlag(undefined)).toBe('g')
        expect(normalizeScriptFlag(null)).toBe('g')
        expect(defaultScriptFlag).toBe('g')
    })

    it('makes spaced and unspaced action tags indistinguishable', () => {
        expect(normalizeScriptFlag('<cbs> <no_end_nl>')).toBe(normalizeScriptFlag('<cbs><no_end_nl>'))
        expect(normalizeScriptFlag(' <cbs>')).toBe(normalizeScriptFlag('<cbs>'))
        expect(normalizeScriptFlag('<cbs> ')).toBe('g')
        expect(normalizeScriptFlag('g i')).toBe('gi')
    })

    it('keeps supported letters, drops unsupported ones, and de-duplicates', () => {
        expect(normalizeScriptFlag('gimsu')).toBe('gimsu')
        expect(normalizeScriptFlag('ggii')).toBe('gi')
        expect(normalizeScriptFlag('g!?x')).toBe('g')
        // Letters that only exist inside a tag are not regex flags.
        expect(normalizeScriptFlag('<cbs>')).toBe('g')
        expect(normalizeScriptFlag('<move_top>')).toBe('g')
        expect(normalizeScriptFlag('i<cbs>')).toBe('i')
    })

    it('always produces a flag string RegExp accepts', () => {
        const samples = ['', ' ', '<cbs> <no_end_nl>', 'ggii', 'g!?x', '<order 3>', 'gimsuy', 'dgimsvy']
        for (const sample of samples) {
            expect(() => new RegExp('a', normalizeScriptFlag(sample))).not.toThrow()
        }
    })
})

describe('script flag tag parsing', () => {
    it('separates tags from letters', () => {
        expect(getScriptFlagTags('gi<cbs><order 3>')).toEqual(['<cbs>', '<order 3>'])
        expect(stripScriptFlagTags('gi<cbs><order 3>')).toBe('gi')
        expect(getScriptFlagTags('')).toEqual([])
    })

    it('does not see a flag letter that only appears inside a tag', () => {
        expect(scriptFlagContains('<cbs>', 's')).toBe(false)
        expect(scriptFlagContains('<move_top>', 'm')).toBe(false)
        expect(scriptFlagContains('<move_top>', 'g')).toBe(false)
        expect(scriptFlagContains('<cbs>s', 's')).toBe(true)
        expect(scriptFlagContains('<cbs>', '<cbs>')).toBe(true)
        expect(scriptFlagContains('<cbs>', '<move_top>')).toBe(false)
    })
})

describe('toggleScriptFlag', () => {
    it('never edits inside a tag for any letter/tag combination', () => {
        for (const tag of actionTags) {
            for (const letter of letterFlags) {
                // The letter is present outside the tag, so this is a "turn off".
                const on = tag + letter
                const off = toggleScriptFlag(on, letter)
                expect(off, `${on} - ${letter}`).toBe(tag)
                expect(getScriptFlagTags(off), `${on} - ${letter}`).toEqual([tag])

                // The letter is absent, so this is a "turn on" and the tag must survive.
                const added = toggleScriptFlag(tag, letter)
                expect(getScriptFlagTags(added), `${tag} + ${letter}`).toEqual([tag])
                expect(scriptFlagContains(added, letter), `${tag} + ${letter}`).toBe(true)
                expect(scriptFlagContains(added, tag), `${tag} + ${letter}`).toBe(true)
            }
        }
    })

    it('leaves every tag intact after toggling every letter on and back off', () => {
        for (const tag of actionTags) {
            let flag = tag
            for (const letter of letterFlags) {
                flag = toggleScriptFlag(flag, letter)
            }
            for (const letter of letterFlags) {
                flag = toggleScriptFlag(flag, letter)
            }
            expect(flag, tag).toBe(tag)
        }
    })

    it('reproduces the exact corruptions the old editor produced', () => {
        // Old behaviour: value.flag.replace(flag, '') on the unstripped string.
        expect('<cbs>s'.replace('s', '')).toBe('<cb>s')
        expect('<move_top>m'.replace('m', '')).toBe('<ove_top>m')
        // Fixed behaviour keeps the tag whole.
        expect(toggleScriptFlag('<cbs>s', 's')).toBe('<cbs>')
        expect(toggleScriptFlag('<move_top>m', 'm')).toBe('<move_top>')
    })

    it('keeps tags in place instead of shuffling them to the end', () => {
        expect(toggleScriptFlag('g<cbs>i', 'g')).toBe('<cbs>i')
        expect(toggleScriptFlag('g<cbs>i', 'i')).toBe('g<cbs>')
    })

    it('toggles whole tags without disturbing letters', () => {
        expect(toggleScriptFlag('gi', '<cbs>')).toBe('gi<cbs>')
        expect(toggleScriptFlag('gi<cbs>', '<cbs>')).toBe('gi')
        expect(toggleScriptFlag('<cbs><move_top>', '<cbs>')).toBe('<move_top>')
        // The order tag is written by a separate control and must survive.
        expect(toggleScriptFlag('<order 3><cbs>', '<cbs>')).toBe('<order 3>')
        expect(toggleScriptFlag('<order -2>g', 'g')).toBe('<order -2>')
    })

    it('removes every stray copy of a letter that leaked in before the fix', () => {
        expect(toggleScriptFlag('gg<cbs>', 'g')).toBe('<cbs>')
        expect(scriptFlagContains(toggleScriptFlag('gg<cbs>', 'g'), 'g')).toBe(false)
    })
})

describe('findUnknownScriptFlagActions', () => {
    it('accepts every action the runner reacts to', () => {
        for (const action of ['move_top', 'move_bottom', 'inject', 'repeat_back', 'cbs', 'no_end_nl']) {
            expect(findUnknownScriptFlagActions(`<${action}>`), action).toEqual([])
        }
        expect(findUnknownScriptFlagActions('<order 3>')).toEqual([])
        expect(findUnknownScriptFlagActions('<order -2>')).toEqual([])
        expect(findUnknownScriptFlagActions('gi')).toEqual([])
        expect(findUnknownScriptFlagActions('')).toEqual([])
        // The runner splits a tag body on commas, so this must too.
        expect(findUnknownScriptFlagActions('<cbs, move_top>')).toEqual([])
    })

    it('reports the tags the old toggle bug produced', () => {
        expect(findUnknownScriptFlagActions('<cb>s')).toEqual(['cb'])
        expect(findUnknownScriptFlagActions('<ove_top>m')).toEqual(['ove_top'])
        expect(findUnknownScriptFlagActions('<cbs><nonsense>')).toEqual(['nonsense'])
    })

    it('reports rather than repairs — the stored value is never guessed at', () => {
        const mangled = '<cb>s'
        expect(findUnknownScriptFlagActions(mangled)).toEqual(['cb'])
        // Nothing in this module rewrites a tag it cannot interpret.
        expect(toggleScriptFlag(mangled, 's')).toBe('<cb>')
        expect(normalizeScriptFlag(mangled)).toBe('s')
    })
})

describe('tryCompileScriptRegex', () => {
    it('reports the error instead of swallowing it', () => {
        const bad = tryCompileScriptRegex('(', 'g')
        expect(bad.regex).toBe(null)
        expect(bad.error).toBeInstanceOf(Error)

        const good = tryCompileScriptRegex('a', 'g')
        expect(good.error).toBe(null)
        expect(good.regex).toBeInstanceOf(RegExp)
    })

    it('shows why the invented u flag broke working patterns', () => {
        // These are the measured cases: legal with the documented default,
        // fatal under the 'u' the old empty-flag fallback substituted in.
        for (const pattern of ['a\\-b', 'a{b', '\\p{Foo}']) {
            expect(tryCompileScriptRegex(pattern, 'g').regex, pattern).toBeInstanceOf(RegExp)
            expect(tryCompileScriptRegex(pattern, 'u').regex, pattern).toBe(null)
            // ...and legal again once the fallback is the documented default.
            expect(tryCompileScriptRegex(pattern, normalizeScriptFlag('<cbs> ')).regex, pattern).toBeInstanceOf(RegExp)
        }
    })
})
