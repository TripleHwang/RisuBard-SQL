import { getDatabase, type character } from './storage/database.svelte'
import { ensureChatHydrated } from './storage/chatStorage'
import { ensureCharacterHydrated } from './storage/sql/sqlRuntimeHydration'
import { LazyResource } from './lazyResource.svelte'

type HydratableCharacter = character & { detailsLoaded?: boolean }

/**
 * Everything opening one character needs loaded, and nothing else.
 *
 * The SQL bootstrap ships characters as summaries -- name, image, chat list,
 * timestamps, and `detailsLoaded: false`. The description, lorebooks, scripts,
 * emotion images and **personas** are not in that summary at all, and neither
 * is a single chat message. So "open this character" is two loads: the record,
 * then the newest page of whatever chat it will land on.
 *
 * Both are reported as failures when they fail. `ensureCharacterHydrated` and
 * `ensureChatHydrated` both answer `null` for "could not", and `null` handed to
 * a screen is a character with no description and a chat with no messages --
 * which is indistinguishable, to the person looking at it, from a character
 * that really is empty. Everything below turns that `null` into a throw, with
 * the one exception that is genuinely benign spelled out where it happens.
 */
export async function loadCharacterForOpen(chaId: string): Promise<void> {
    await loadCharacterRecord(chaId)

    const db = getDatabase()
    // The hydrator REPLACES the entry in `db.characters`, so the object that
    // was read before the await is not the one the app now holds. Re-resolve.
    const current = db.characters.find((value) => value?.chaId === chaId)
    if (!current) throw new Error(`Character "${chaId}" was removed while it was loading`)

    const chatIndex = current.chatPage ?? 0
    const chat = current.chats?.[chatIndex]
    // A character with no chat in that slot has nothing more to load. This is
    // absence of a chat, not a failed read of one: `chats` is part of the
    // bootstrap summary, so its shape is known even before hydration.
    if (!chat) return

    const loaded = await ensureChatHydrated(current.chats, chatIndex, chaId)
    if (!loaded) {
        throw new Error(
            `Chat "${chat.id ?? chatIndex}" of character "${chaId}" could not be loaded. ` +
            'Its messages are unknown, not absent.',
        )
    }
}

/**
 * Load the character record alone -- description, lorebooks, scripts, emotion
 * images, personas -- without touching any chat's messages.
 *
 * Surfaces that only need the record (the persona manager is the one that
 * matters: `personas` is simply not in the bootstrap summary) use this, so
 * "opening the persona tab" does not drag a chat page in behind it.
 */
export async function loadCharacterRecord(chaId: string): Promise<void> {
    if (!chaId) throw new Error('Cannot load a character with no id')
    const db = getDatabase()
    const index = db.characters.findIndex((value) => value?.chaId === chaId)
    if (index === -1) throw new Error(`Character "${chaId}" is no longer in the character list`)

    const hydrated = await ensureCharacterHydrated(db, index)
    if (!hydrated) {
        // `ensureCharacterHydrated` returns `null` for two unrelated reasons:
        // the backend produced no record, and the character was hydrated (or
        // removed) by someone else while this request was out. Only the first
        // is a failure, and the difference is readable from the database right
        // now -- so read it, rather than treating every null as either.
        const current = db.characters.find((value) => value?.chaId === chaId) as HydratableCharacter | undefined
        if (!current) throw new Error(`Character "${chaId}" was removed while it was loading`)
        if (current.detailsLoaded === false) {
            throw new Error(`Character "${chaId}" could not be loaded from storage`)
        }
        // Someone else finished the same hydration first. Nothing is wrong.
    }
}

/**
 * True when this character's record is still only a bootstrap summary.
 *
 * The summary carries the name, image, chat list and timestamps -- and nothing
 * else. Reading `character.personas` off one yields `undefined`, and a persona
 * manager that renders that as an empty grid is telling the user this character
 * has no personas. `ensureCharacterPersonas` would then write `[]` over the
 * field, and the next commit would persist that as the truth.
 */
export function characterRecordNeedsLoad(value: character | undefined | null): boolean {
    return !!value && (value as HydratableCharacter).detailsLoaded === false
}

/**
 * True when opening this character still needs a load. Surfaces use it to skip
 * the loading state entirely for characters that are already resident, so
 * clicking a character you just came back from is instant and paints nothing.
 */
export function characterOpenNeedsLoad(value: character | undefined | null): boolean {
    if (!value) return false
    if (characterRecordNeedsLoad(value)) return true
    const chat = value.chats?.[value.chatPage ?? 0] as (typeof value.chats)[number] & {
        messagesLoaded?: boolean
    } | undefined
    if (!chat) return false
    return chat._placeholder === true || chat.messagesLoaded === false
}

/**
 * The shared wiring behind every "open this character" control.
 *
 * Three surfaces open characters -- the desktop sidebar, the mobile list, and
 * the grid catalog -- and all three used to hand the job to `changeChar`, which
 * raised the app-wide `loadingOverlayStore`. That overlay is `fixed inset-0
 * z-[60]`: while one character loaded, nothing else in the app could be
 * clicked. Loading one thing is not allowed to freeze the rest, so the load
 * happens here first and each surface renders its own progress and its own
 * failure, in its own subtree.
 *
 * `changeChar` is still what navigates. By the time it is called the record and
 * the newest message page are resident, which is exactly the path where it
 * raises no overlay of its own.
 *
 * `auto: false`: opening is something the user presses, not something a
 * component does because it appeared. That also means this can be constructed
 * outside component initialisation.
 */
export class CharacterOpener {
    #requestedId = $state<string | null>(null)
    #navigate: (index: number) => void
    #resource: LazyResource<void>

    constructor(navigate: (index: number) => void) {
        this.#navigate = navigate
        this.#resource = new LazyResource<void>({
            scope: 'character-open',
            key: () => this.#requestedId,
            load: (chaId) => loadCharacterForOpen(chaId),
            auto: false,
        })
    }

    /** The state a surface renders its loading and failure branches from. */
    get resource(): LazyResource<void> { return this.#resource }

    /** Name of the character the current status describes, for the failure text. */
    get openingName(): string {
        const chaId = this.#resource.stateKey
        if (!chaId) return ''
        return getDatabase().characters.find((value) => value?.chaId === chaId)?.name ?? ''
    }

    /** True while this specific row is the one being loaded. */
    isOpening(chaId: string | undefined | null): boolean {
        return !!chaId && this.#resource.loading && this.#resource.stateKey === chaId
    }

    /** Open by list index, as a click handler has it. */
    open(index: number): void {
        const chaId = getDatabase().characters[index]?.chaId
        if (!chaId) return
        void this.openById(chaId)
    }

    async openById(chaId: string): Promise<void> {
        const db = getDatabase()
        const index = db.characters.findIndex((value) => value?.chaId === chaId)
        if (index === -1) return
        // Already resident: no request, no spinner, and any earlier failure
        // stops being shown because it is no longer about anything.
        if (!characterOpenNeedsLoad(db.characters[index])) {
            if (this.#resource.stateKey !== null) this.#resource.reset()
            this.#requestedId = null
            this.#navigate(index)
            return
        }
        this.#requestedId = chaId
        await this.#resource.request()
        // A newer press owns the screen; this one lost the race and must not
        // navigate on top of it.
        if (this.#resource.stateKey !== chaId || !this.#resource.ready) return
        const currentIndex = getDatabase().characters.findIndex((value) => value?.chaId === chaId)
        if (currentIndex === -1) return
        this.#navigate(currentIndex)
    }

    /** Re-run the open that failed. Retrying and succeeding also navigates. */
    retryCurrent(): void {
        const chaId = this.#resource.stateKey
        if (chaId) void this.openById(chaId)
    }
}

export function createCharacterOpener(navigate: (index: number) => void): CharacterOpener {
    return new CharacterOpener(navigate)
}
