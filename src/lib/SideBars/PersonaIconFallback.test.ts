// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { flushSync, mount, tick, unmount } from 'svelte'
import type { Database } from 'src/ts/storage/database.svelte'

// A persona icon's asset can 404 -- e.g. an already-deleted asset (see
// cleanChunks()/getUncleanables()). On the Node server build getFileSrc()
// hands back `/api/asset/<hex>` unconditionally, without checking that the
// key exists, so the <img> is always rendered and always fires `error` for a
// missing asset. Each of the three persona renderers is supposed to notice
// that and swap in its placeholder instead of the browser's broken-image glyph.
//
// These tests mount the real components and dispatch a real `error` event.
// They deliberately do NOT assert on source text: the previous version of this
// file did exactly that and went green over a fallback that could never fire.
// The state was held in a plain `$state(new Set())`, and Svelte 5 does not
// deep-proxy a Set (see svelte/src/internal/client/proxy.js -- a value whose
// prototype is neither object_prototype nor array_prototype is returned
// unproxied), so `.add()` signalled nothing, `.has()` in the template
// registered no dependency, and the `{#if}` never re-evaluated.

// The dialog/switch/menu chrome is irrelevant here, and importing the real
// bits-ui barrel currently fails to resolve (`bits-ui/dist/types.js`).
vi.mock('bits-ui', () => {
    const Stub = () => {}
    const parts = () => new Proxy({}, { get: () => Stub })
    return {
        AlertDialog: parts(), Collapsible: parts(), Dialog: parts(),
        DropdownMenu: parts(), RadioGroup: parts(), Slider: parts(),
        Switch: parts(), Toggle: parts(), Tooltip: parts(),
    }
})

// Only getCharImage is redirected: `plain` is the mode all three persona
// badges use, and it must return a non-empty src so the <img> is rendered
// and can fail the way it does against a real Node server.
vi.mock('src/ts/characters', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getCharImage: vi.fn(async (loc: string, type: string) => {
        if (!loc) return type === 'css' ? '' : null
        return type === 'plain' ? `/api/asset/${loc}` : `background: url("/api/asset/${loc}");`
    }),
}))

vi.mock('src/ts/globalApi.svelte', () => ({
    getFileSrc: vi.fn(async (loc: string) => `/api/asset/${loc}`),
    requestImmediateSave: vi.fn(async () => undefined),
    saveAsset: vi.fn(async () => 'asset'),
    checkCharOrder: vi.fn(),
    forageStorage: { createAuth: vi.fn(async () => 'auth') },
    requiresFullEncoderReload: { state: false },
}))

vi.mock('src/ts/alert', () => ({
    alertConfirm: vi.fn(async () => true),
    alertConfirmMulti: vi.fn(async () => 0),
    alertInput: vi.fn(async () => ''),
    alertSelect: vi.fn(async () => 0),
    alertError: vi.fn(),
    notifySuccess: vi.fn(),
}))

import PersonaBind from './PersonaBind.svelte'
import Sidebar from './Sidebar.svelte'
import PersonaSettings from '../Setting/Pages/PersonaSettings.svelte'

// DBState is `$state`, so assigning `.db` drives the mounted components
// without having to stub the whole store surface.
const { DBState, selectedCharID } = await import('src/ts/stores.svelte')

const BROKEN_ICON = 'deadbeefdeadbeefdeadbeefdeadbeef'
const BROKEN_SELECTOR = `img[src*="${BROKEN_ICON}"]`

function makeDb(): Database {
    return {
        personas: [{
            id: 'persona-1',
            name: 'Broken Icon Persona',
            icon: BROKEN_ICON,
            personaPrompt: '',
            note: '',
        }],
        selectedPersona: 0,
        username: 'Broken Icon Persona',
        userIcon: BROKEN_ICON,
        personaPrompt: '',
        characters: [{
            chaId: 'char-1',
            name: 'Ada',
            image: '',
            type: 'character',
            chatPage: 0,
            chats: [{ id: 'chat-1', name: 'Chat', message: [], bindedPersona: '' }],
        }],
        characterOrder: ['char-1'],
        language: 'en',
    } as unknown as Database
}

let mounted: ReturnType<typeof mount> | undefined

async function render(Component: unknown) {
    const target = document.body.appendChild(document.createElement('div'))
    mounted = mount(Component as never, { target, props: {} })
    await tick()
    // The persona <img> lives behind `{#await getCharImage(...)}`.
    await vi.waitFor(() => {
        expect(
            target.querySelector<HTMLImageElement>(BROKEN_SELECTOR),
            'the persona <img> should render before the load error',
        ).not.toBeNull()
    })
    return target
}

/**
 * Dispatch the event a browser fires when the asset comes back 404, then let
 * Svelte settle, and report what took the broken image's place.
 */
function failTheIcon(target: HTMLElement) {
    const img = target.querySelector<HTMLImageElement>(BROKEN_SELECTOR)!
    const slot = img.parentElement!
    img.dispatchEvent(new Event('error'))
    flushSync()
    return {
        brokenImageRemoved: target.querySelector(BROKEN_SELECTOR) === null,
        // Every one of the three renderers falls back to either a lucide/solar
        // <svg> icon or a `.persona-placeholder` span, in the same slot.
        fallbackRendered: !!slot.querySelector('svg, .persona-placeholder'),
    }
}

describe('persona icon 404 fallback', () => {
    beforeEach(() => {
        DBState.db = makeDb()
        selectedCharID.set(0)
    })

    afterEach(async () => {
        if (mounted) await unmount(mounted)
        mounted = undefined
        document.body.replaceChildren()
    })

    test('the main sidebar persona badge swaps the broken image for a placeholder', async () => {
        const target = await render(Sidebar)

        expect(failTheIcon(target)).toEqual({
            brokenImageRemoved: true,
            fallbackRendered: true,
        })
    })

    test('the persona bind selector swaps the broken image for a placeholder', async () => {
        const target = await render(PersonaBind)

        expect(failTheIcon(target)).toEqual({
            brokenImageRemoved: true,
            fallbackRendered: true,
        })
    })

    test('the persona manager grid swaps the broken tile image for a placeholder', async () => {
        const target = await render(PersonaSettings)

        expect(failTheIcon(target)).toEqual({
            brokenImageRemoved: true,
            fallbackRendered: true,
        })
        expect(
            target.querySelector('.persona-tile .persona-placeholder'),
            'the grid tile should show its placeholder span',
        ).not.toBeNull()
    })
})
