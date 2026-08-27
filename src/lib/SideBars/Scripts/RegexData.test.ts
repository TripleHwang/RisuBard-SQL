// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { writable } from 'svelte/store'

vi.mock('src/lang', () => ({
    language: {
        removeConfirm: 'remove ',
        name: 'Name',
        editInput: 'Edit Input',
        editOutput: 'Edit Output',
        editProcess: 'Edit Process',
        editDisplay: 'Edit Display',
        editTranslationDisplay: 'Edit Translation Display',
        disabled: 'Disabled',
        help: {},
    },
}))
vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(async () => false),
}))
// The OUT editor drags in the CBS highlighter and the whole DBState graph; this
// suite is about the FLAGS controls, so render it as a no-op component.
vi.mock('../../UI/GUI/TextAreaInput.svelte', () => ({ default: () => {} }))
// The lucide barrel is thousands of modules and costs ~30s of transform here.
// Only the icons the mounted tree actually pulls in need stubbing.
vi.mock('@lucide/svelte', () => {
    const icon = () => {}
    return {
        TriangleAlertIcon: icon,
        TriangleAlert: icon,
        XIcon: icon,
        ChevronDown: icon,
        ChevronDownIcon: icon,
        CheckIcon: icon,
        FlaskConicalIcon: icon,
        CircleQuestionMarkIcon: icon,
    }
})
vi.mock('src/ts/stores.svelte', () => ({
    ReloadGUIPointer: writable(0),
    isTouchDevice: writable(false),
    DBState: { db: {} },
}))

import RegexData from './RegexData.svelte'
import type { customscript } from 'src/ts/storage/database.svelte'

let mounted: ReturnType<typeof mount> | undefined

const makeScript = (flag: string): customscript => ({
    comment: 'panel',
    in: 'panel',
    out: 'X',
    type: 'editoutput',
    ableFlag: true,
    flag,
} as customscript)

function buttonByText(text: string): HTMLButtonElement {
    const found = Array.from(document.body.querySelectorAll('button'))
        .find((b) => b.textContent?.trim() === text)
    if (!found) {
        throw new Error(`no button labelled "${text}"; saw: ${
            Array.from(document.body.querySelectorAll('button')).map((b) => JSON.stringify(b.textContent?.trim())).join(', ')
        }`)
    }
    return found as HTMLButtonElement
}

/** Mount one row, open it, and expand the FLAGS accordion. */
async function openFlagEditor(value: customscript) {
    mounted = mount(RegexData, {
        target: document.body,
        props: { value, idx: 0 },
    })
    await tick()
    buttonByText(value.comment).click()
    await tick()
    buttonByText('FLAGS').click()
    await tick()
}

beforeEach(() => {
    document.body.replaceChildren()
})

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('RegexData flag toggles', () => {
    test('turning a letter off does not cut a character out of an action tag', async () => {
        const value = makeScript('<cbs>s')
        await openFlagEditor(value)

        // Old behaviour: value.flag.replace('s','') on the raw string -> "<cb>s".
        buttonByText('Dot All (s)').click()
        await tick()

        expect(value.flag).toBe('<cbs>')
        expect(value.flag).toContain('<cbs>')
    })

    test('turning m off leaves <move_top> whole', async () => {
        const value = makeScript('<move_top>m')
        await openFlagEditor(value)

        buttonByText('Multi Line (m)').click()
        await tick()

        expect(value.flag).toBe('<move_top>')
    })

    test('a letter that only exists inside a tag reads as off', async () => {
        const value = makeScript('<cbs>')
        await openFlagEditor(value)

        // Clicking "Dot All (s)" on "<cbs>" must ADD s, not delete the tag's s.
        buttonByText('Dot All (s)').click()
        await tick()

        expect(value.flag).toContain('<cbs>')
        expect(value.flag.replace(/<.+?>/g, '')).toBe('s')
    })

    test('tag toggles round-trip without touching letters', async () => {
        const value = makeScript('gi')
        await openFlagEditor(value)

        buttonByText('IN CBS Parsing').click()
        await tick()
        expect(value.flag).toBe('gi<cbs>')

        buttonByText('IN CBS Parsing').click()
        await tick()
        expect(value.flag).toBe('gi')
    })
})

describe('RegexData broken-pattern signal', () => {
    test('names the pattern, the effective flag and the cause for an invalid pattern', async () => {
        const value = makeScript('g')
        value.in = '('
        await openFlagEditor(value)

        const shown = document.body.textContent ?? ''
        expect(shown).toContain('Invalid regex')
        expect(shown).toContain('/(/g')
        expect(shown).toContain('Unterminated group')
    })

    test('says nothing for a pattern that compiles', async () => {
        await openFlagEditor(makeScript('g'))
        expect(document.body.textContent).not.toContain('Invalid regex')
    })

    test('marks a broken script while the row is still collapsed', async () => {
        const value = makeScript('g')
        value.in = '('
        mounted = mount(RegexData, { target: document.body, props: { value, idx: 0 } })
        await tick()

        // Nothing is expanded, so the only signal available is on the header row.
        expect(document.body.textContent).not.toContain('IN:')
        const marked = Array.from(document.body.querySelectorAll('[title]'))
            .map((e) => e.getAttribute('title'))
        expect(marked.some((t) => t?.includes('Invalid regex'))).toBe(true)
    })

    test('flags an already-mangled action tag without rewriting it', async () => {
        // What a user who clicked "Dot All (s)" once before the fix is left with.
        const value = makeScript('<cb>s')
        await openFlagEditor(value)

        expect(document.body.textContent).toContain('Unknown flag action <cb>')
        // Reported, not repaired: the stored value is untouched.
        expect(value.flag).toBe('<cb>s')
    })

    test('leaves a healthy collapsed row unmarked', async () => {
        const value = makeScript('g')
        mounted = mount(RegexData, { target: document.body, props: { value, idx: 0 } })
        await tick()

        const marked = Array.from(document.body.querySelectorAll('[title]'))
            .map((e) => e.getAttribute('title'))
        expect(marked.some((t) => t?.includes('Invalid regex'))).toBe(false)
    })

    test('stays quiet for a pattern that is legal under the default flag', async () => {
        // These only fail under the 'u' the runtime used to invent.
        for (const pattern of ['a\\-b', 'a{b']) {
            document.body.replaceChildren()
            const value = makeScript('<cbs> ')
            value.in = pattern
            await openFlagEditor(value)
            expect(document.body.textContent, pattern).not.toContain('Invalid regex')
            await unmount(mounted!)
            mounted = undefined
        }
    })
})
