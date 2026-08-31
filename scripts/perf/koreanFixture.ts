/**
 * A database shaped like the reporting user's, not like an English test.
 *
 * Two things about Korean text change the numbers and have misled this project
 * before:
 *
 *   - three UTF-8 bytes per character on the wire and on disk, against one for
 *     ASCII, so a fixture measured in "characters" is three times heavier than
 *     an English one of the same length once it is serialised;
 *   - two bytes per code unit *in memory*, because V8 stores any string
 *     containing a non-Latin1 character as a two-byte string. That also takes
 *     `JSON.stringify` off its one-byte fast path, which is the part an ASCII
 *     benchmark cannot see at all.
 *
 * So every string here is real Hangul. Nothing in this file is user data: the
 * syllables are generated from the Unicode Hangul block.
 */

const HANGUL_BASE = 0xac00
const HANGUL_COUNT = 11_172

/** Deterministic, so two runs of the same size are comparable. */
function makeRandom(seed: number): () => number {
    let state = seed >>> 0 || 1
    return () => {
        state ^= state << 13; state >>>= 0
        state ^= state >>> 17
        state ^= state << 5; state >>>= 0
        return state / 0x1_0000_0000
    }
}

/** `length` Hangul syllables with spaces and sentence punctuation mixed in. */
export function koreanText(length: number, random: () => number): string {
    const out: string[] = []
    for (let index = 0; index < length; index++) {
        const roll = random()
        if (roll < 0.14 && index > 0) out.push(' ')
        else if (roll < 0.16 && index > 0) out.push('. ')
        else out.push(String.fromCharCode(HANGUL_BASE + Math.floor(random() * HANGUL_COUNT)))
    }
    return out.join('')
}

export type FixtureShape = {
    /** Characters in the sidebar. All of them are resident as metadata. */
    characters: number
    /** Chats per character. Resident as summaries; only a few carry messages. */
    chatsPerCharacter: number
    /** Chats whose messages are actually in memory (the hydrated-chat LRU). */
    hydratedChats: number
    /** Messages resident in each hydrated chat. */
    messagesPerHydratedChat: number
    /** Korean syllables per message body. */
    messageLength: number
    /** Saved prompt presets. Each is fingerprinted whole, every pass. */
    presets: number
    /** Global lorebook entries, which live on a single root key. */
    loreEntries: number
}

export const SHAPES: Record<string, FixtureShape> = {
    /** A light user: a handful of characters, one chat open. */
    light: {
        characters: 10, chatsPerCharacter: 3, hydratedChats: 1,
        messagesPerHydratedChat: 320, messageLength: 300, presets: 4, loreEntries: 40,
    },
    /**
     * The reporting user's shape: tens of characters, long histories, two
     * chats hydrated (the LRU bound), each windowed to MAX_RESIDENT_MESSAGES.
     */
    reporting: {
        characters: 40, chatsPerCharacter: 8, hydratedChats: 2,
        messagesPerHydratedChat: 320, messageLength: 400, presets: 10, loreEntries: 200,
    },
    /** A heavy library, same residency bounds. Isolates metadata growth. */
    heavy: {
        characters: 120, chatsPerCharacter: 20, hydratedChats: 2,
        messagesPerHydratedChat: 320, messageLength: 400, presets: 20, loreEntries: 600,
    },
    /**
     * What the audit costs if the residency window is ever bypassed: the same
     * library, with two chats fully loaded at a few thousand messages each.
     * This is the shape the windowing exists to prevent, kept here so the cost
     * of losing it is a number rather than an argument.
     */
    unwindowed: {
        characters: 40, chatsPerCharacter: 8, hydratedChats: 2,
        messagesPerHydratedChat: 4_000, messageLength: 400, presets: 10, loreEntries: 200,
    },
}

function makeMessage(random: () => number, chatId: string, index: number, length: number) {
    return {
        chatId: `${chatId}-m-${index}`,
        role: index % 2 ? 'char' : 'user',
        data: koreanText(length, random),
        time: 1_700_000_000_000 + index * 60_000,
        ...(index % 2 ? {
            generationInfo: {
                model: 'claude-sonnet-4', generationId: `gen-${chatId}-${index}`,
                inputTokens: 4000 + index, outputTokens: 300 + (index % 200), maxContext: 200_000,
            },
        } : {}),
        ...(index % 7 === 0 ? { swipes: [koreanText(length, random), koreanText(length, random)], swipeId: 0 } : {}),
    }
}

/**
 * Builds one in-memory `Database` of the requested shape.
 *
 * Non-hydrated chats carry `message: []` with `messagesFullyLoaded: false`,
 * which is exactly what `rebuildBootstrap` produces and what the audit sees for
 * every chat the user has not opened.
 */
export function buildKoreanDatabase(shape: FixtureShape, seed = 20_260_831): any {
    const random = makeRandom(seed)
    let hydratedLeft = shape.hydratedChats
    const characters = Array.from({ length: shape.characters }, (_, characterIndex) => {
        const chaId = `character-${String(characterIndex).padStart(3, '0')}`
        return {
            chaId,
            type: 'character',
            name: koreanText(8, random),
            image: `${chaId}-portrait`,
            desc: koreanText(1_200, random),
            notes: koreanText(200, random),
            firstMessage: koreanText(600, random),
            alternateGreetings: [koreanText(500, random), koreanText(500, random)],
            personality: koreanText(300, random),
            scenario: koreanText(300, random),
            exampleMessage: koreanText(900, random),
            creatorNotes: koreanText(250, random),
            systemPrompt: koreanText(400, random),
            postHistoryInstructions: koreanText(200, random),
            tags: [koreanText(4, random), koreanText(4, random), koreanText(4, random)],
            creator: koreanText(6, random),
            characterVersion: '1.0',
            chatPage: 0,
            viewScreen: 'none',
            bias: [], emotionImages: [], sdData: [],
            chatFolders: [],
            globalLore: Array.from({ length: 12 }, (_, entry) => ({
                key: koreanText(10, random),
                comment: koreanText(20, random),
                content: koreanText(400, random),
                mode: 'normal', insertorder: entry, alwaysActive: false, secondkey: '', selective: false,
            })),
            customscript: Array.from({ length: 6 }, () => ({
                comment: koreanText(15, random), in: koreanText(30, random),
                out: koreanText(60, random), type: 'editdisplay', flag: '', ableFlag: false,
            })),
            triggerscript: [],
            utilityBot: false,
            chats: Array.from({ length: shape.chatsPerCharacter }, (_, chatIndex) => {
                const id = `${chaId}-chat-${String(chatIndex).padStart(2, '0')}`
                const hydrate = hydratedLeft > 0 && chatIndex === 0
                if (hydrate) hydratedLeft -= 1
                return {
                    id,
                    name: koreanText(12, random),
                    note: koreanText(40, random),
                    localLore: [],
                    lastDate: 1_700_000_000_000 + chatIndex,
                    fmIndex: -1,
                    message: hydrate
                        ? Array.from({ length: shape.messagesPerHydratedChat }, (_, index) =>
                            makeMessage(random, id, index, shape.messageLength))
                        : [],
                    // Every chat the user has not opened looks like this, and
                    // the audit still fingerprints its summary on every pass.
                    messagesLoaded: hydrate,
                    messagesFullyLoaded: false,
                }
            }),
        }
    })

    return {
        characters,
        botPresets: Array.from({ length: shape.presets }, (_, index) => ({
            id: `preset-${index}`,
            name: koreanText(10, random),
            mainPrompt: koreanText(2_000, random),
            jailbreak: koreanText(1_500, random),
            globalNote: koreanText(800, random),
            promptTemplate: Array.from({ length: 20 }, () => ({
                type: 'plain', text: koreanText(200, random), role: 'system', type2: 'normal',
            })),
            temperature: 80, maxContext: 200_000, maxResponse: 4_000,
        })),
        botPresetsId: 0,
        pluginCustomStorage: {},
        // Root keys. These are what `changedRootKeys` watches and what nothing
        // else in the application marks dirty.
        username: koreanText(6, random),
        userIcon: 'user-portrait',
        userNote: koreanText(200, random),
        mainPrompt: koreanText(2_000, random),
        jailbreak: koreanText(1_500, random),
        globalNote: koreanText(800, random),
        apiType: 'claude', aiModel: 'claude-sonnet-4', openAIKey: '', proxyKey: '',
        temperature: 80, maxContext: 200_000, maxResponse: 4_000,
        frequencyPenalty: 70, PresensePenalty: 70,
        formatingOrder: ['main', 'description', 'chats', 'lastChat', 'jailbreak', 'lorebook', 'globalNote', 'authorNote'],
        loreBook: [{
            id: 'global-lore',
            name: koreanText(10, random),
            data: Array.from({ length: shape.loreEntries }, (_, entry) => ({
                key: koreanText(10, random),
                comment: koreanText(20, random),
                content: koreanText(500, random),
                mode: 'normal', insertorder: entry, alwaysActive: false, secondkey: '', selective: false,
            })),
        }],
        loreBookPage: 0, loreBookDepth: 5, loreBookToken: 800,
        personas: Array.from({ length: 5 }, (_, index) => ({
            name: koreanText(6, random), personaPrompt: koreanText(400, random),
            icon: `persona-${index}`, largePortrait: false,
        })),
        modules: Array.from({ length: 8 }, (_, index) => ({
            id: `module-${index}`, name: koreanText(8, random),
            description: koreanText(200, random),
            lorebook: Array.from({ length: 10 }, () => ({
                key: koreanText(8, random), content: koreanText(300, random),
                mode: 'normal', insertorder: 0, alwaysActive: false, secondkey: '', selective: false,
            })),
            regex: [], cjs: '', trigger: [],
        })),
        globalscript: Array.from({ length: 10 }, () => ({
            comment: koreanText(15, random), in: koreanText(30, random),
            out: koreanText(60, random), type: 'editdisplay', flag: '', ableFlag: false,
        })),
        plugins: [],
        customBackground: '', zoomsize: 100, language: 'ko', translator: 'google',
        autoTranslate: false, currentPluginProvider: '',
        textgenWebUIStreamURL: '', textgenWebUIBlockingURL: '', forceReplaceUrl: '',
        additionalPrompt: '', descriptionPrefix: '', cipherChat: false, jailbreakToggle: true,
    }
}

/** UTF-8 bytes, which is what this database costs on the wire and on disk. */
export function utf8Bytes(value: unknown): number {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}

/** Resident messages, for reporting alongside every measurement. */
export function residentMessageCount(database: any): number {
    let total = 0
    for (const character of database.characters ?? []) {
        for (const chat of character.chats ?? []) total += (chat.message ?? []).length
    }
    return total
}

export function chatCount(database: any): number {
    let total = 0
    for (const character of database.characters ?? []) total += (character.chats ?? []).length
    return total
}
