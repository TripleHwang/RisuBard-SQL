import { getCurrentCharacter, getDatabase } from './storage/database.svelte'
import { ensureChatHydrated } from './storage/chatStorage'
import { LazyResource } from './lazyResource.svelte'

/**
 * Opening one chat: load its newest page, then switch to it.
 *
 * The SQL bootstrap ships a character's chats as slots -- id, name, folder and
 * `messagesLoaded: false` -- with not one message in them. So "open this chat"
 * is a load, and until now it was a load behind `loadingOverlayStore`, which
 * `LoadingOverlay.svelte` renders as `fixed inset-0 z-[60]` across the whole
 * app: for the length of one chat's fetch nothing else could be clicked, not
 * the other chats in the same list, not the character list, not settings.
 *
 * The user's requirement is the opposite of that, so the fetch happens here
 * with the progress and the failure rendered by the list the user clicked in,
 * and the switch itself is left to the caller's `navigate` callback -- which
 * calls `changeChatTo(index, { alreadyLoaded: true })`, the path where it
 * raises no overlay of its own.
 *
 * `navigate` is a callback rather than a direct `changeChatTo` import, and the
 * selected character is read through `getCurrentCharacter()` rather than
 * `selIdState`, so that this module's imports stay narrow: `database.svelte`,
 * `chatStorage`, `lazyResource`, and nothing else. That is the same shape
 * `createCharacterOpener` already has -- the opener loads, the caller navigates
 * -- and it keeps this module out of the `stores.svelte` <->
 * `storage/database.svelte` <-> `process/modules` import cycle whose
 * module-scope `$effect` (stores.svelte.ts:274) is the source of the known TDZ
 * this repo already lives with.
 */

/** Identity of one chat slot, for the shared in-flight map. */
function chatKeyFor(chaId: string, chatIndex: number): string {
    return `${chaId}::${chatIndex}`
}

function parseChatKey(key: string): { chaId: string, chatIndex: number } {
    const separator = key.lastIndexOf('::')
    return {
        chaId: key.slice(0, separator),
        chatIndex: Number(key.slice(separator + 2)),
    }
}

/**
 * Load the newest page of one chat, or throw.
 *
 * `ensureChatHydrated` answers `null` for "could not", and a `null` that reaches
 * a screen is a conversation rendered with no messages -- which is what a chat
 * that really is empty looks like. A user who believes that regenerates from
 * the greeting, or deletes the chat. So the `null` becomes a throw here, and
 * the surface that asked shows it.
 */
export async function loadChatForOpen(chaId: string, chatIndex: number): Promise<void> {
    const db = getDatabase()
    const character = db.characters.find((value) => value?.chaId === chaId)
    if (!character) throw new Error(`Character "${chaId}" is no longer in the character list`)
    const slot = character.chats?.[chatIndex]
    if (!slot) throw new Error(`Character "${chaId}" has no chat at position ${chatIndex}`)

    const hydrated = await ensureChatHydrated(character.chats, chatIndex, chaId)
    if (!hydrated) {
        throw new Error(
            `Chat "${slot.id ?? chatIndex}" could not be loaded. Its messages are unknown, not absent.`,
        )
    }
}

/**
 * True when opening this chat still needs a fetch.
 *
 * Deliberately NOT `isChatHistoryIncomplete`. That predicate is true for any
 * partial window, including the perfectly normal one where the newest 40
 * messages are resident and older ones are a click away -- and treating that as
 * "needs loading" would put a spinner on every long chat, every time, forever.
 * The question here is only whether this chat has been read at all.
 */
export function chatOpenNeedsLoad(
    chat: { _placeholder?: boolean, messagesLoaded?: boolean } | undefined | null,
): boolean {
    if (!chat) return false
    return chat._placeholder === true || chat.messagesLoaded === false
}

/**
 * The shared wiring behind every "open this chat" control.
 *
 * `auto: false`: opening a chat is something the user presses, not something a
 * component does because it appeared, so this can also be constructed outside
 * component initialisation.
 */
export class ChatOpener {
    #requestedKey = $state<string | null>(null)
    #navigate: (chatIndex: number) => void
    #resource: LazyResource<void>

    constructor(navigate: (chatIndex: number) => void) {
        this.#navigate = navigate
        this.#resource = new LazyResource<void>({
            scope: 'chat-open',
            key: () => this.#requestedKey,
            load: (key) => {
                const { chaId, chatIndex } = parseChatKey(key)
                return loadChatForOpen(chaId, chatIndex)
            },
            auto: false,
        })
    }

    /** The state a surface renders its loading and failure branches from. */
    get resource(): LazyResource<void> { return this.#resource }

    /** Name of the chat the current status describes, for the failure text. */
    get openingName(): string {
        const key = this.#resource.stateKey
        if (!key) return ''
        const { chaId, chatIndex } = parseChatKey(key)
        const character = getDatabase().characters.find((value) => value?.chaId === chaId)
        return character?.chats?.[chatIndex]?.name ?? ''
    }

    /** True while this specific row is the one being loaded. */
    isOpening(chatIndex: number): boolean {
        if (!this.#resource.loading) return false
        const key = this.#resource.stateKey
        return !!key && parseChatKey(key).chatIndex === chatIndex
    }

    /**
     * Open by position in the selected character's chat list, as a click has it.
     *
     * The selected character is resolved from the same `selectedCharID` that
     * `changeChatTo` reads, so the index this opener loads and the index the
     * caller's `navigate` switches to are always positions in the same array.
     */
    open(chatIndex: number): void {
        const chaId = getCurrentCharacter()?.chaId
        if (!chaId) return
        void this.openIn(chaId, chatIndex)
    }

    async openIn(chaId: string, chatIndex: number): Promise<void> {
        const db = getDatabase()
        const character = db.characters.find((value) => value?.chaId === chaId)
        const slot = character?.chats?.[chatIndex]
        if (!character || !slot) return
        // Already resident: no request, no spinner, and any earlier failure
        // stops being shown because it is no longer about anything.
        if (!chatOpenNeedsLoad(slot)) {
            if (this.#resource.stateKey !== null) this.#resource.reset()
            this.#requestedKey = null
            this.#navigate(chatIndex)
            return
        }
        const key = chatKeyFor(chaId, chatIndex)
        this.#requestedKey = key
        await this.#resource.request()
        // A newer press owns the screen; this one lost the race and must not
        // switch the chat out from under it.
        if (this.#resource.stateKey !== key || !this.#resource.ready) return
        this.#navigate(chatIndex)
    }

    /** Re-run the open that failed. Retrying and succeeding also switches. */
    retryCurrent(): void {
        const key = this.#resource.stateKey
        if (!key) return
        const { chaId, chatIndex } = parseChatKey(key)
        void this.openIn(chaId, chatIndex)
    }
}

export function createChatOpener(navigate: (chatIndex: number) => void): ChatOpener {
    return new ChatOpener(navigate)
}
