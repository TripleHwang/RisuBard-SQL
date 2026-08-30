import { flushSync, mount, unmount } from 'svelte'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const activeStorage = vi.hoisted(() => ({ current: null as any }))

vi.mock('src/ts/storage/sql/sqlBootstrap', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getActiveSqlStorage: () => activeStorage.current,
}))

const PersonaSettings = (await import('./PersonaSettings.svelte')).default
const { DBState, selectedCharID } = await import('src/ts/stores.svelte')
const { resetLazyLoadsForTesting } = await import('src/ts/lazyResource.svelte')

/**
 * "The persona tab loads personas."
 *
 * `personas` is not in the bootstrap character summary. The summary carries the
 * name, the image, the chat list and the timestamps; the personas, the
 * description, the lorebooks and the scripts arrive only with the character
 * record. So the character tab of the persona manager, opened on a character
 * nobody had loaded yet, read `undefined` and rendered zero tiles under the
 * message "this character has no personas".
 *
 * That is not a cosmetic wrong answer. The next thing the user does is press
 * the create button, `ensureCharacterPersonas` installs `[]` on the summary,
 * the new persona goes in alone, and the commit persists one persona for a
 * character that had several.
 *
 * The component is mounted for real and driven through its own tab control,
 * with a backend that answers the record on the same interface the node one
 * does, because the claim is about what this tab shows and what it lets the
 * user press.
 */

let host: HTMLDivElement | null = null
let app: ReturnType<typeof mount> | null = null

const REAL_PERSONAS = [
    { name: 'Archivist', icon: '', personaPrompt: 'p1', note: '', id: 'char-persona-1' },
    { name: 'Envoy', icon: '', personaPrompt: 'p2', note: '', id: 'char-persona-2' },
]

function installDatabase() {
    DBState.db = {
        characters: [{
            chaId: 'cha-1',
            type: 'character',
            name: 'Alpha',
            image: '',
            chatPage: 0,
            detailsLoaded: false,
            chats: [{ id: 'cha-1-chat', name: 'chat', note: '', localLore: [], message: [], messagesLoaded: false }],
        }],
        personas: [{ name: 'me', icon: '', personaPrompt: '', note: '', id: 'global-1' }],
        selectedPersona: 0,
        username: 'me',
        userIcon: '',
        personaPrompt: '',
        userNote: '',
    } as unknown as typeof DBState.db
    selectedCharID.set(0)
}

function serveRecord(options: { fails?: boolean; hold?: boolean } = {}) {
    let release!: (value: unknown) => void
    activeStorage.current = {
        backendKind: 'server-sql',
        loadCharacterHydration: vi.fn(async (chaId: string) => {
            if (options.hold) await new Promise((resolve) => { release = resolve })
            if (options.fails) throw new Error('the character record is unreachable')
            return {
                chaId,
                type: 'character',
                name: 'Alpha',
                image: '',
                chatPage: 0,
                desc: 'a real description',
                personas: REAL_PERSONAS.map((persona) => ({ ...persona })),
                chats: [{ id: 'cha-1-chat', name: 'chat', note: '', localLore: [], message: [], messagesLoaded: false }],
            }
        }),
        loadChatMessageReversePage: vi.fn(async (chatId: string) => ({
            revision: 1, chatId, messages: [], positions: [], nextPosition: 0,
            before: null, nextBefore: null, total: 0, hasMore: false,
        })),
    }
    return () => release?.(null)
}

function render() {
    host = document.createElement('div')
    document.body.append(host)
    app = mount(PersonaSettings, { target: host, props: { embedded: true } })
    flushSync()
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve()
        flushSync()
    }
}

function characterTab(): HTMLElement {
    const tabs = [...(host?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])]
    const tab = tabs[1]
    if (!tab) throw new Error('the persona manager rendered no character tab')
    return tab
}

beforeEach(() => {
    resetLazyLoadsForTesting()
    installDatabase()
})

afterEach(() => {
    if (app) unmount(app)
    app = null
    host?.remove()
    host = null
    activeStorage.current = null
    resetLazyLoadsForTesting()
    vi.restoreAllMocks()
})

describe('the persona tab loads the character it is showing personas for', () => {
    test('an unloaded character shows loading, not "this character has no personas"', async () => {
        const release = serveRecord({ hold: true })

        render()
        characterTab().click()
        flushSync()

        const text = host?.textContent ?? ''
        expect(host?.querySelector('[role="status"]')).not.toBeNull()
        // The claim that would have been made about data nobody had read.
        expect(text).not.toContain('This character has no personas yet.')
        // And the button that would have acted on that claim is not offered.
        expect(host?.querySelector('[data-persona-create]')).toBeNull()

        release()
        await settle()
    })

    test('once the record loads, the character\'s real personas are shown', async () => {
        serveRecord()

        render()
        characterTab().click()
        await settle()

        const tiles = [...(host?.querySelectorAll<HTMLElement>('.persona-tile') ?? [])]
        expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual(['Archivist', 'Envoy'])
        expect(host?.querySelector('[data-persona-create]')).not.toBeNull()
    })

    test('a failed record load is shown, and still does not offer to create over it', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        serveRecord({ fails: true })

        render()
        characterTab().click()
        await settle()

        const alert = host?.querySelector('[role="alert"]')
        expect(alert).not.toBeNull()
        expect(host?.textContent ?? '').not.toContain('This character has no personas yet.')
        expect(host?.querySelector('[data-persona-create]')).toBeNull()
        expect(host?.querySelectorAll('.persona-tile').length).toBe(0)
    })

    test('the global tab is unaffected: its personas are already in memory', async () => {
        serveRecord({ hold: true })

        render()
        await settle()

        expect(host?.querySelector('[role="status"]')).toBeNull()
        const tiles = [...(host?.querySelectorAll<HTMLElement>('.persona-tile') ?? [])]
        expect(tiles.map((tile) => tile.getAttribute('aria-label'))).toEqual(['me'])
    })
})
