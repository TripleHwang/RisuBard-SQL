import { flushSync, mount, unmount } from 'svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const activeStorage = vi.hoisted(() => ({ current: null as any }))

vi.mock('src/ts/storage/sql/sqlBootstrap', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getActiveSqlStorage: () => activeStorage.current,
}))

const MobileCharacters = (await import('./MobileCharacters.svelte')).default
const { DBState, selectedCharID, loadingOverlayStore } = await import('src/ts/stores.svelte')
const { resetLazyLoadsForTesting } = await import('src/ts/lazyResource.svelte')

/**
 * The mobile character list, held to the same rule as the sidebar: opening a
 * character loads that character, in this list's own subtree, without an
 * app-wide blocker and without closing the list onto a character nobody read.
 *
 * The old row handler was `void changeChar(char.i); endGrid()`. Both halves were
 * wrong together: `changeChar` raised `loadingOverlayStore` (rendered as
 * `fixed inset-0 z-[60]` over the whole app) and `endGrid()` ran immediately, so
 * a hydration that failed still dismissed the list and dropped the user on a
 * screen showing a character with no description and a chat with no messages --
 * indistinguishable, to the person looking at it, from a character that really
 * is empty. Every editor on that screen writes back.
 *
 * `CharacterVaultConnections.test.ts` used to pin this call site by asserting
 * the component source literally contained `void changeChar(char.i)`. That
 * proves a string is present, not that a click does anything; this mounts the
 * component and clicks the row.
 */

let host: HTMLDivElement | null = null
let app: ReturnType<typeof mount> | null = null
/** Every value the app-wide overlay took while the test ran. */
let overlayStates: boolean[] = []
let unsubscribeOverlay: (() => void) | null = null
let gridEnded = 0

function makeCharacter(chaId: string, name: string) {
    return {
        chaId,
        type: 'character',
        name,
        image: '',
        chatPage: 0,
        lastInteraction: 0,
        // Exactly the shape the SQL bootstrap ships: no description, no
        // personas, no lore, and not one message.
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
                lastInteraction: 0,
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
        loadChatMessageReversePage: vi.fn(async (chatId: string, before: number | undefined) => ({
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
    app = mount(MobileCharacters, {
        target: host,
        props: { search: '', gridMode: true, endGrid: () => { gridEnded += 1 } },
    })
    flushSync()
}

async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await Promise.resolve()
        flushSync()
    }
}

function characterRow(name: string): HTMLElement {
    const rows = [...(host?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    const found = rows.find((row) => row.textContent?.includes(name))
    if (!found) throw new Error(`no row for "${name}" in the mobile character list`)
    return found
}

beforeEach(() => {
    resetLazyLoadsForTesting()
    installDatabase()
    gridEnded = 0
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

describe('the mobile character list opens a character without blocking the app', () => {
    /**
     * The opener rests at `idle` for as long as nobody presses a row -- which
     * for this list is most of its life. `LazyState` used to fall back to its
     * loading branch there, so this list carried a permanent "Loading…" row
     * above the characters from the moment it opened. A spinner that never
     * stops is worse than none: it says something is happening when nothing is.
     */
    test('an untouched list shows no loading row at all', () => {
        serveCharacters()
        render()

        expect(host?.querySelector('[role="status"]')).toBeNull()
        expect(host?.querySelector('[role="alert"]')).toBeNull()
    })

    test('a successful open selects the character and dismisses the list', async () => {
        serveCharacters()
        render()

        characterRow('Alpha').click()
        await settle()

        expect(get(selectedCharID)).toBe(0)
        expect(gridEnded).toBe(1)
        // Not "inactive by the end" -- never raised at all. An overlay that is
        // correctly hidden afterwards still froze the app while it was up.
        expect(overlayStates.some(Boolean)).toBe(false)
    })

    test('opening a character still clears its new-character badge', async () => {
        serveCharacters()
        ;(DBState.db as any).characterVault = { newCharacterIds: ['cha-1', 'cha-2'] }
        render()

        characterRow('Alpha').click()
        await settle()

        expect((DBState.db as any).characterVault.newCharacterIds).toEqual(['cha-2'])
    })

    test('the list shows its own loading state and stays usable while one row loads', async () => {
        let finish!: (value: unknown) => void
        activeStorage.current = {
            backendKind: 'server-sql',
            loadCharacterHydration: vi.fn(() => new Promise((resolve) => { finish = resolve })),
            loadChatMessageReversePage: vi.fn(),
        }
        render()

        characterRow('Alpha').click()
        flushSync()

        const status = host?.querySelector('[role="status"]')
        expect(status).not.toBeNull()
        expect(status?.textContent ?? '').toContain('Alpha')
        expect(overlayStates.some(Boolean)).toBe(false)
        // The list is still mounted and the other character is still there to
        // be pressed; nothing was taken away for the length of the fetch.
        expect(characterRow('Beta')).toBeTruthy()
        // And the list has not closed on a character that is not loaded yet.
        expect(gridEnded).toBe(0)
        expect(get(selectedCharID)).toBe(-1)

        // Settle before the test ends: the hydrator dedupes by character id
        // across the whole module, so a pending promise left here would be
        // handed to the next test and hang it.
        finish(null)
        await settle()
    })

    test('a failed open is shown here, and neither selects nor dismisses', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        serveCharacters({ hydrationFails: true })
        render()

        characterRow('Alpha').click()
        await settle()

        const alert = host?.querySelector('[role="alert"]')
        expect(alert).not.toBeNull()
        expect(alert?.textContent ?? '').toContain('Alpha')
        expect(alert?.textContent ?? '').toContain('storage is unreachable')
        // The list must not close onto a character nobody managed to read.
        expect(gridEnded).toBe(0)
        expect(get(selectedCharID)).toBe(-1)
        expect(overlayStates.some(Boolean)).toBe(false)
    })

    test('retrying a failed open loads it and then dismisses the list', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        let failing = true
        activeStorage.current = {
            backendKind: 'server-sql',
            loadCharacterHydration: vi.fn(async (chaId: string) => {
                if (failing) throw new Error('storage is unreachable')
                return {
                    chaId, type: 'character', name: 'Alpha', image: '', chatPage: 0, lastInteraction: 0,
                    desc: 'a real description', personas: [],
                    chats: [{ id: `${chaId}-chat`, name: 'chat', note: '', localLore: [], message: [], messagesLoaded: false, messagesFullyLoaded: false }],
                }
            }),
            loadChatMessageReversePage: vi.fn(async (chatId: string) => ({
                revision: 1, chatId, messages: [], positions: [], nextPosition: 0,
                before: null, nextBefore: null, total: 0, hasMore: false,
            })),
        }
        render()

        characterRow('Alpha').click()
        await settle()
        const retry = [...(host?.querySelectorAll<HTMLElement>('[role="alert"] button') ?? [])][0]
        expect(retry).toBeTruthy()

        failing = false
        retry.click()
        await settle()

        expect(host?.querySelector('[role="alert"]')).toBeNull()
        expect(get(selectedCharID)).toBe(0)
        expect(gridEnded).toBe(1)
        expect(overlayStates.some(Boolean)).toBe(false)
    })
})
