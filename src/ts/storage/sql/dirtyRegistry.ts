export type DirtySnapshot = {
    rootKeys: string[]
    characterIds: string[]
    chats: Array<{ characterId: string; chatId: string; manifest: boolean }>
    messages: Array<{ chatId: string; messageIds: string[] }>
    messageManifestChatIds: string[]
    messageDeletes: Array<{ chatId: string; messageIds: string[] }>
    pluginStorageKeys: string[]
    presetIds: string[]
}

type DirtyChat = {
    characterId: string
    chatId: string
    manifest: boolean
    generation: number
}

const separator = '\u0000'

export class DirtyRegistry {
    private generation = 0
    private readonly rootKeys = new Map<string, number>()
    private readonly characterIds = new Map<string, number>()
    private readonly chats = new Map<string, DirtyChat>()
    private readonly messages = new Map<string, Map<string, number>>()
    private readonly messageManifestChatIds = new Map<string, number>()
    private readonly messageDeletes = new Map<string, Map<string, number>>()
    private readonly pluginStorageKeys = new Map<string, number>()
    private readonly presetIds = new Map<string, number>()
    private readonly snapshotGenerations = new WeakMap<DirtySnapshot, Map<string, number>>()
    private timer: ReturnType<typeof setTimeout> | undefined
    private inFlight: Promise<void> | undefined
    private inFlightGeneration = 0
    private followUpRequested = false

    constructor(private readonly onFlush: () => Promise<void>) {}

    markRoot(key: string): void {
        this.rootKeys.set(key, this.nextGeneration())
    }

    markCharacter(characterId: string): void {
        this.characterIds.set(characterId, this.nextGeneration())
    }

    markChat(characterId: string, chatId: string, manifest = false): void {
        const key = this.chatKey(characterId, chatId)
        const previous = this.chats.get(key)
        this.chats.set(key, {
            characterId,
            chatId,
            manifest: previous?.manifest === true || manifest,
            generation: this.nextGeneration(),
        })
    }

    markMessage(chatId: string, messageId: string): void {
        this.markNested(this.messages, chatId, messageId)
    }

    markMessageManifest(chatId: string): void {
        this.messageManifestChatIds.set(chatId, this.nextGeneration())
    }

    markMessageDeleted(chatId: string, messageId: string): void {
        this.markNested(this.messageDeletes, chatId, messageId)
    }

    markPluginStorage(key: string): void {
        this.pluginStorageKeys.set(key, this.nextGeneration())
    }

    markPreset(id: string): void {
        this.presetIds.set(id, this.nextGeneration())
    }

    takeSnapshot(): DirtySnapshot {
        const generations = new Map<string, number>()
        const snapshot: DirtySnapshot = {
            rootKeys: this.snapshotKeys('root', this.rootKeys, generations),
            characterIds: this.snapshotKeys('character', this.characterIds, generations),
            chats: [...this.chats.values()]
                .sort((a, b) => this.chatKey(a.characterId, a.chatId).localeCompare(this.chatKey(b.characterId, b.chatId)))
                .map(chat => {
                    generations.set(this.chatScope(chat.characterId, chat.chatId), chat.generation)
                    return { characterId: chat.characterId, chatId: chat.chatId, manifest: chat.manifest }
                }),
            messages: this.snapshotNested('message', this.messages, generations),
            messageManifestChatIds: this.snapshotKeys('message-manifest', this.messageManifestChatIds, generations),
            messageDeletes: this.snapshotNested('message-delete', this.messageDeletes, generations),
            pluginStorageKeys: this.snapshotKeys('plugin-storage', this.pluginStorageKeys, generations),
            presetIds: this.snapshotKeys('preset', this.presetIds, generations),
        }
        this.snapshotGenerations.set(snapshot, generations)
        return snapshot
    }

    acknowledge(snapshot: DirtySnapshot): void {
        const generations = this.snapshotGenerations.get(snapshot)
        if (!generations) return

        this.acknowledgeKeys('root', snapshot.rootKeys, this.rootKeys, generations)
        this.acknowledgeKeys('character', snapshot.characterIds, this.characterIds, generations)
        for (const chat of snapshot.chats) {
            const key = this.chatKey(chat.characterId, chat.chatId)
            const current = this.chats.get(key)
            if (current?.generation === generations.get(this.chatScope(chat.characterId, chat.chatId))) this.chats.delete(key)
        }
        this.acknowledgeNested('message', snapshot.messages, this.messages, generations)
        this.acknowledgeKeys('message-manifest', snapshot.messageManifestChatIds, this.messageManifestChatIds, generations)
        this.acknowledgeNested('message-delete', snapshot.messageDeletes, this.messageDeletes, generations)
        this.acknowledgeKeys('plugin-storage', snapshot.pluginStorageKeys, this.pluginStorageKeys, generations)
        this.acknowledgeKeys('preset', snapshot.presetIds, this.presetIds, generations)
    }

    schedule(delay = 300): void {
        if (this.timer !== undefined) return
        this.timer = setTimeout(() => {
            this.timer = undefined
            if (this.inFlight) {
                if (this.generation > this.inFlightGeneration) this.followUpRequested = true
                return
            }
            void this.flushNow().catch(() => undefined)
        }, delay)
    }

    flushNow(): Promise<void> {
        this.clearTimer()
        if (this.inFlight) return this.inFlight

        this.inFlightGeneration = this.generation
        const flush = Promise.resolve().then(() => this.onFlush())
        this.inFlight = flush
        void flush.then(
            () => this.clearInFlight(flush),
            () => this.clearInFlight(flush),
        )
        return flush
    }

    private nextGeneration(): number {
        this.generation += 1
        return this.generation
    }

    private markNested(collection: Map<string, Map<string, number>>, parentId: string, id: string): void {
        let values = collection.get(parentId)
        if (!values) {
            values = new Map()
            collection.set(parentId, values)
        }
        values.set(id, this.nextGeneration())
    }

    private snapshotKeys(scope: string, values: Map<string, number>, generations: Map<string, number>): string[] {
        return [...values.keys()].sort().map(key => {
            generations.set(`${scope}${separator}${key}`, values.get(key)!)
            return key
        })
    }

    private snapshotNested(
        scope: string,
        values: Map<string, Map<string, number>>,
        generations: Map<string, number>,
    ): Array<{ chatId: string; messageIds: string[] }> {
        return [...values.keys()].sort().map(chatId => ({
            chatId,
            messageIds: [...values.get(chatId)!.keys()].sort().map(messageId => {
                generations.set(`${scope}${separator}${chatId}${separator}${messageId}`, values.get(chatId)!.get(messageId)!)
                return messageId
            }),
        }))
    }

    private acknowledgeKeys(
        scope: string,
        keys: string[],
        values: Map<string, number>,
        generations: Map<string, number>,
    ): void {
        for (const key of keys) {
            if (values.get(key) === generations.get(`${scope}${separator}${key}`)) values.delete(key)
        }
    }

    private acknowledgeNested(
        scope: string,
        groups: Array<{ chatId: string; messageIds: string[] }>,
        values: Map<string, Map<string, number>>,
        generations: Map<string, number>,
    ): void {
        for (const { chatId, messageIds } of groups) {
            const current = values.get(chatId)
            if (!current) continue
            for (const messageId of messageIds) {
                if (current.get(messageId) === generations.get(`${scope}${separator}${chatId}${separator}${messageId}`)) {
                    current.delete(messageId)
                }
            }
            if (current.size === 0) values.delete(chatId)
        }
    }

    private chatKey(characterId: string, chatId: string): string {
        return `${characterId}${separator}${chatId}`
    }

    private chatScope(characterId: string, chatId: string): string {
        return `chat${separator}${this.chatKey(characterId, chatId)}`
    }

    private clearTimer(): void {
        if (this.timer === undefined) return
        clearTimeout(this.timer)
        this.timer = undefined
    }

    private clearInFlight(flush: Promise<void>): void {
        if (this.inFlight !== flush) return
        this.inFlight = undefined
        if (this.followUpRequested && this.generation > this.inFlightGeneration && this.hasDirtyState()) {
            this.followUpRequested = false
            this.schedule(0)
            return
        }
        this.followUpRequested = false
    }

    private hasDirtyState(): boolean {
        return this.rootKeys.size > 0
            || this.characterIds.size > 0
            || this.chats.size > 0
            || this.messages.size > 0
            || this.messageManifestChatIds.size > 0
            || this.messageDeletes.size > 0
            || this.pluginStorageKeys.size > 0
            || this.presetIds.size > 0
    }
}
