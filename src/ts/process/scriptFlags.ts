/**
 * Flag handling for regex scripts (`customscript.flag`).
 *
 * A stored flag string mixes two different things:
 *   - plain ECMAScript RegExp flag letters (`g`, `i`, `m`, `s`, `u`, ...)
 *   - Risu action tags written as `<...>` (`<cbs>`, `<move_top>`, `<order 3>`, ...)
 *
 * Both the runtime (`scripts.ts`) and the flag editor (`RegexData.svelte`) have to
 * split those two apart, and both used to do it with slightly different ad-hoc
 * string surgery. Keeping the split in one place is what stops a letter edit from
 * reaching inside a tag, and stops the runtime from inventing a flag nobody asked
 * for.
 */

/**
 * Matches a single `<...>` action tag. Deliberately identical to the pattern the
 * script runner uses when it peels actions off the flag string, so both sides
 * agree on where a tag starts and ends.
 */
const tagRegex = /<.+?>/g

/** RegExp flag letters this build accepts. Anything else (including whitespace) is dropped. */
const unsupportedFlagLetters = /[^dgimsuvy]/g

/**
 * The documented default. `scripts.ts` uses it whenever a script has no custom
 * flag at all, so an emptied-out custom flag has to land on the same value —
 * never on something stricter like `u`, which rejects patterns (`a\-b`, `a{b`)
 * that compile fine everywhere else.
 */
export const defaultScriptFlag = 'g'

/** Every `<...>` tag in `flag`, in source order. */
export function getScriptFlagTags(flag: string | undefined | null): string[] {
    return (flag ?? '').match(tagRegex) ?? []
}

/** `flag` with every `<...>` tag removed, leaving only the RegExp flag letters (and any junk between them). */
export function stripScriptFlagTags(flag: string | undefined | null): string {
    return (flag ?? '').replace(tagRegex, '')
}

/**
 * Turn a stored flag string into the flag string actually handed to `RegExp`.
 *
 * Drops action tags, drops unsupported characters (whitespace included, so
 * `"<cbs> <no_end_nl>"` and `"<cbs><no_end_nl>"` are indistinguishable here),
 * de-duplicates letters, and falls back to `g` when nothing usable is left.
 */
export function normalizeScriptFlag(flag: string | undefined | null): string {
    const letters = stripScriptFlagTags(flag)
        .replace(unsupportedFlagLetters, '')
        .split('')
        .filter((v, i, a) => a.indexOf(v) === i)
        .join('')

    return letters.length === 0 ? defaultScriptFlag : letters
}

/**
 * Is `token` currently set on `flag`?
 *
 * A `<tag>` token matches only a whole tag; a letter token is looked up only in
 * the tag-stripped remainder, so the `s` in `<cbs>` never counts as the Dot All flag.
 */
export function scriptFlagContains(flag: string | undefined | null, token: string): boolean {
    if (token.startsWith('<')) {
        return getScriptFlagTags(flag).includes(token)
    }
    return stripScriptFlagTags(flag).includes(token)
}

/**
 * Toggle `token` on `flag` and return the new flag string.
 *
 * The important guarantee: a single-letter toggle only ever edits the parts of
 * the string that sit *outside* `<...>` tags. Editing the raw string instead
 * (the old behaviour) turned `"<cbs>s"` into `"<cb>s"` and `"<move_top>m"` into
 * `"<ove_top>m"` — a silent, permanent corruption of a working script from one click.
 */
export function toggleScriptFlag(flag: string | undefined | null, token: string): string {
    const current = flag ?? ''

    if (token.startsWith('<')) {
        if (!scriptFlagContains(current, token)) {
            return current + token
        }
        // Remove one whole tag. Splitting keeps tags addressable as units so a
        // repeated tag loses exactly one copy and letters are never touched.
        let removed = false
        return splitOnTags(current)
            .map((part, i) => {
                if (i % 2 === 1 && !removed && part === token) {
                    removed = true
                    return ''
                }
                return part
            })
            .join('')
    }

    if (!scriptFlagContains(current, token)) {
        // Appending lands after the final `>`, so it cannot end up inside a tag.
        return current + token
    }

    return splitOnTags(current)
        .map((part, i) => (i % 2 === 1 ? part : part.split(token).join('')))
        .join('')
}

/** Split into alternating [text, tag, text, tag, ... , text]; odd indices are whole `<...>` tags. */
function splitOnTags(flag: string): string[] {
    return flag.split(/(<.+?>)/g)
}

/**
 * Every action `scripts.ts` actually reacts to. `order n` is handled separately
 * because it carries a value.
 */
export const knownScriptFlagActions = [
    'move_top',
    'move_bottom',
    'inject',
    'repeat_back',
    'cbs',
    'no_end_nl',
] as const

/**
 * Tags that no longer name an action.
 *
 * Existing saves can carry tags the old flag editor chewed a letter out of
 * (`<cb>`, `<ove_top>`). Mapping those back to what the user meant would be
 * guesswork, so nothing is rewritten — they are only reported, where the user
 * can decide. A tag body may list several comma-separated actions, matching the
 * way the runtime splits it.
 */
export function findUnknownScriptFlagActions(flag: string | undefined | null): string[] {
    const unknown: string[] = []
    for (const tag of getScriptFlagTags(flag)) {
        for (const action of tag.slice(1, -1).split(',').map((v) => v.trim())) {
            if (action.startsWith('order ')) {
                continue
            }
            if (!(knownScriptFlagActions as readonly string[]).includes(action)) {
                unknown.push(action)
            }
        }
    }
    return unknown
}

export type ScriptRegexCompileResult =
    | { regex: RegExp; error: null }
    | { regex: null; error: SyntaxError | Error }

/**
 * Compile without throwing. Callers get the actual error so it can be reported
 * instead of vanishing — a regex script that cannot compile used to be dropped
 * with no log, no alert and no mark in the editor.
 */
export function tryCompileScriptRegex(input: string, flag: string): ScriptRegexCompileResult {
    try {
        return { regex: new RegExp(input, flag), error: null }
    }
    catch (error) {
        return { regex: null, error: error instanceof Error ? error : new Error(String(error)) }
    }
}
