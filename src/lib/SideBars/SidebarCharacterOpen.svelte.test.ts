import { flushSync, mount, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const activeStorage = vi.hoisted(() => ({ current: null as any }))

vi.mock('src/ts/storage/sql/sqlBootstrap', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getActiveSqlStorage: () => activeStorage.current,
}))

const Sidebar = (await import('./Sidebar.svelte')).default
const { DBState, selectedCharID, loadingOverlayStore } = await import('src/ts/stores.svelte')
const { resetLazyLoadsForTesting } = await import('src/ts/lazyResource.svelte')

/**
 * "Opening a character loads that character ... and loading must not make the
 * rest of the app unusable while it happens."
 *
 * Two things were wrong with the old path, and both are visible from the DOM.
 *
 * It raised `loadingOverlayStore`, which `LoadingOverlay.svelte` renders as
 * `fixed inset-0 z-[60]` over the entire app. Every other control -- the other
 * characters, the settings button, the chat you were already reading -- became
 * unclickable for the length of one character's fetch. A full-screen blocker
 * with a missed hide is what made an earlier release unusable outright; the
 * only durable fix is not to have one on this path.
 *
 * And a hydration that failed produced nothing at all: `changeChar` returned
 * early on a null record and swallowed a chat failure into `console.error`. The
 * click looked ignored. A user does not read the console; they click again,
 * then decide the character is broken.
 *
 * The character list is really mounted and really clicked, and the backend is a
 * fake with the same contract as the node one, because the claim is about what
 * happens on screen.
 */

let host: HTMLDivElement | null = null
let app: ReturnType<typeof mount> | null = null
/** Every value the app-wide overlay took while the test ran. */
let overlayStates: boolean[] = []
let unsubscribeOverlay: (() => void) | null = null

function makeCharacter(chaId: string, name: string) {
    return {
        chaId,
        type: 'character',
        name,
        image: '',
        chatPage: 0,
        // Exactly the shape `readCharacterSummaries` ships at bootstrap: no
        // description, no personas, no lore, and not one message.
        detailsLoaded: false,
        chats: [{
            id: `${chaId}-chat`,
            name: 'chat',
            note: '',
            localLore: [],
            message: [] as unknown[],
            messagesLoaded: false,
            messagesFullyLoaded: false,
        }],
    }
}

function installDatabase() {
    DBState.db = {
        characters: [makeCharacter('cha-1', 'Alpha'), makeCharacter('cha-2', 'Beta')],
        personas: [{ name: 'me', icon: '', personaPrompt: '', note: '', id: 'persona-1' }],
        selectedPersona: 0,
        username: 'me',
        userIcon: '',
        personaPrompt: '',
        userNote: '',
        characterOrder: ['cha-1', 'cha-2'],
        botPresets: [],
        botPresetsId: 0,
        plugins: [],
        globalChatVariables: {},
        customBackground: '',
        sideBarSize: 20,
        iconSize: 100,
        characterVaultNew: [],
        collectionOrganizers: {},
        modules: [],
        enabledModules: [],
        formatingOrder: [],
        loreBook: [],
        loreBookPage: 0,
        templateDefaultVariables: '',
    } as unknown as typeof DBState.db
    selectedCharID.set(-1)
}

/** A backend that answers a character record, or refuses to. */
function serveCharacters(options: { hydrationFails?: boolean } = {}) {
    activeStorage.current = {
        backendKind: 'server-sql',
        loadCharacterHydration: vi.fn(async (chaId: string) => {
            if (options.hydrationFails) throw new Error('storage is unreachable')
            return {
                chaId,
                type: 'character',
                name: chaId === 'cha-1' ? 'Alpha' : 'Beta',
                image: '',
                chatPage: 0,
                desc: 'a real description',
                personas: [],
                chats: [{
                    id: `${chaId}-chat`,
                    name: 'chat',
                    note: '',
                    localLore: [],
                    message: [],
                    messagesLoaded: false,
                    messagesFullyLoaded: false,
                }],
            }
        }),
        loadChatMessageReversePage: vi.fn(async (chatId: string, before: number | undefined, limit: number) => ({
            revision: 1,
            chatId,
            messages: [{ chatId: 'm-0', role: 'char', data: 'hello' }],
            positions: [0],
            nextPosition: 1,
            before: before ?? null,
            nextBefore: null,
            total: 1,
            hasMore: false,
        })),
    }
    return activeStorage.current
}

function render() {
    host = document.createElement('div')
    document.body.append(host)
    app = mount(Sidebar, { target: host })
    flushSync()
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve()
        flushSync()
    }
}

function characterButton(chaId: string): HTMLElement {
    const row = host?.querySelector<HTMLElement>(`[data-drag-id="${chaId}"]`)
    const found = row?.querySelector<HTMLElement>('[role="button"]')
    if (!found) throw new Error(`no character row for "${chaId}" in the sidebar`)
    return found
}

beforeEach(() => {
    resetLazyLoadsForTesting()
    installDatabase()
    overlayStates = []
    loadingOverlayStore.set({ active: false, text: '', onCancel: null })
    unsubscribeOverlay = loadingOverlayStore.subscribe((value) => overlayStates.push(value.active))
})

afterEach(() => {
    unsubscribeOverlay?.()
    unsubscribeOverlay = null
    if (app) unmount(app)
    app = null
    host?.remove()
    host = null
    activeStorage.current = null
    resetLazyLoadsForTesting()
    vi.restoreAllMocks()
})

describe('opening a character loads only that character, in the sidebar itself', () => {
    test('no app-wide blocking overlay is ever raised while a character loads', async () => {
        serveCharacters()
        render()

        characterButton('cha-1').click()
        flushSync()
        await settle()

        expect(get(selectedCharID)).toBe(0)
        // Not "was inactive at the end" -- never active at all. A blocker that
        // is correctly hidden afterwards still froze the app while it was up.
        expect(overlayStates.some(Boolean)).toBe(false)
    })

    test('the sidebar shows its own loading state on the row being opened', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        // Held open so the loading state can be observed while it is real.
        let finish!: (value: unknown) => void
        activeStorage.current = {
            backendKind: 'server-sql',
            loadCharacterHydration: vi.fn(() => new Promise((resolve) => { finish = resolve })),
            loadChatMessageReversePage: vi.fn(),
        }
        render()

        characterButton('cha-1').click()
        flushSync()

        const busy = host?.querySelector('[data-character-open-busy]')
        expect(busy).not.toBeNull()
        expect(busy?.getAttribute('data-character-open-busy')).toBe('cha-1')
        // The progress marker is inside the row, not over the app.
        expect(document.querySelector('.risu-modal-overlay')).toBeNull()
        expect(overlayStates.some(Boolean)).toBe(false)
        // The rest of the sidebar is still there and still clickable.
        expect(host?.querySelector('[data-drag-id="cha-2"]')).not.toBeNull()
        expect(busy?.className ?? '').toContain('pointer-events-none')

        // Settle it before the test ends: the hydrator dedupes by character id
        // across the whole module, so an in-flight promise left pending here
        // would be handed to the next test and hang it.
        finish(null)
        await settle()
    })

    test('a failed character load is shown, and does not open the character', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        serveCharacters({ hydrationFails: true })
        render()

        characterButton('cha-1').click()
        flushSync()
        await settle()

        const alert = host?.querySelector('[role="alert"]')
        expect(alert).not.toBeNull()
        expect(alert?.textContent ?? '').toContain('Alpha')
        // A character that could not be read must not be opened onto a screen
        // that renders its missing description and empty chat as if they were
        // the character.
        expect(get(selectedCharID)).toBe(-1)
        expect(overlayStates.some(Boolean)).toBe(false)
    })

    /**
     * The new-character badge is cleared by `changeChar`, and routing the click
     * through the opener moved the call site. `CharacterVaultConnections.test.ts`
     * used to pin that by asserting the sidebar source literally contained
     * `void changeChar(index, { reseter })`, which proves only that a string is
     * present -- it would have passed just as happily with the call inside a
     * branch that never runs, and it broke the moment the call moved into the
     * opener's navigate callback without anything about the behaviour changing.
     * This clicks the real row and reads the real database instead.
     */
    test('opening a character still clears its new-character badge', async () => {
        serveCharacters()
        ;(DBState.db as any).characterVault = { newCharacterIds: ['cha-1', 'cha-2'] }
        render()

        characterButton('cha-1').click()
        await settle()

        expect(get(selectedCharID)).toBe(0)
        expect((DBState.db as any).characterVault.newCharacterIds).toEqual(['cha-2'])
    })

    /**
     * The badge must survive a load that never opened the character. Clearing
     * "new" for a character the user never got to see would quietly retire the
     * marker that tells them to look at it.
     */
    test('a character whose load failed keeps its new-character badge', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        serveCharacters({ hydrationFails: true })
        ;(DBState.db as any).characterVault = { newCharacterIds: ['cha-1'] }
        render()

        characterButton('cha-1').click()
        await settle()

        expect(get(selectedCharID)).toBe(-1)
        expect((DBState.db as any).characterVault.newCharacterIds).toEqual(['cha-1'])
    })

    test('the failure clears when another character opens successfully', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        let failing = true
        activeStorage.current = {
            backendKind: 'server-sql',
            loadCharacterHydration: vi.fn(async (chaId: string) => {
                if (failing) throw new Error('storage is unreachable')
                return {
                    chaId, type: 'character', name: 'Beta', image: '', chatPage: 0,
                    desc: 'x', personas: [],
                    chats: [{ id: `${chaId}-chat`, name: 'chat', note: '', localLore: [], message: [], messagesLoaded: false, messagesFullyLoaded: false }],
                }
            }),
            loadChatMessageReversePage: vi.fn(async (chatId: string) => ({
                revision: 1, chatId, messages: [], positions: [], nextPosition: 0,
                before: null, nextBefore: null, total: 0, hasMore: false,
            })),
        }
        render()

        characterButton('cha-1').click()
        await settle()
        expect(host?.querySelector('[role="alert"]')).not.toBeNull()

        failing = false
        characterButton('cha-2').click()
        await settle()

        expect(host?.querySelector('[role="alert"]')).toBeNull()
        expect(get(selectedCharID)).toBe(1)
    })
})
