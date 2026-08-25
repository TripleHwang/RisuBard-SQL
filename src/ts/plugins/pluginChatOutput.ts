export type ChatOutputListenerArg = {
    char: any
    chat: any
    characterIndex: number
    chatIndex: number
    messageIndex: number
}

export type ChatOutputListener = (arg: ChatOutputListenerArg) => void | Promise<void>
export type ChatOutputListenerOwner = string

export const V2_CHAT_OUTPUT_OWNER = 'v2'

const serializedSnapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

export class PluginChatOutputListeners {
    private readonly listenersByOwner = new Map<ChatOutputListenerOwner, Set<ChatOutputListener>>()
    private readonly cleanupOwners = new Set<ChatOutputListenerOwner>()

    get size() {
        let size = 0
        for (const listeners of this.listenersByOwner.values()) {
            size += listeners.size
        }
        return size
    }

    add(owner: ChatOutputListenerOwner, listener: ChatOutputListener) {
        let listeners = this.listenersByOwner.get(owner)
        if (!listeners) {
            listeners = new Set()
            this.listenersByOwner.set(owner, listeners)
        }
        listeners.add(listener)
    }

    remove(owner: ChatOutputListenerOwner, listener: ChatOutputListener) {
        const listeners = this.listenersByOwner.get(owner)
        if (!listeners) {
            return
        }
        listeners.delete(listener)
        if (listeners.size === 0) {
            this.listenersByOwner.delete(owner)
        }
    }

    clear(owner: ChatOutputListenerOwner) {
        this.listenersByOwner.delete(owner)
    }

    ensureOwnerCleanup(
        owner: ChatOutputListenerOwner,
        registerCleanup: (cleanup: () => void) => void,
    ) {
        if (this.cleanupOwners.has(owner)) {
            return
        }
        this.cleanupOwners.add(owner)
        try {
            registerCleanup(() => {
                this.clear(owner)
                this.cleanupOwners.delete(owner)
            })
        }
        catch (error) {
            this.cleanupOwners.delete(owner)
            throw error
        }
    }

    async dispatch(output: ChatOutputListenerArg) {
        if (this.size === 0) {
            return
        }
        const canonicalOutput = serializedSnapshot(output)
        for (const listeners of this.listenersByOwner.values()) {
            for (const listener of listeners) {
                try {
                    await listener(serializedSnapshot(canonicalOutput))
                }
                catch (error) {
                    console.error(error)
                }
            }
        }
    }
}

export function addOwnedChatOutputListener(
    listeners: PluginChatOutputListeners,
    owner: ChatOutputListenerOwner,
    mode: string,
    listener: ChatOutputListener,
) {
    if (mode !== 'output') {
        throw (`chat listener mode ${mode} not found`)
    }
    listeners.add(owner, listener)
}

export function removeOwnedChatOutputListener(
    listeners: PluginChatOutputListeners,
    owner: ChatOutputListenerOwner,
    mode: string,
    listener: ChatOutputListener,
) {
    if (mode !== 'output') {
        throw (`chat listener mode ${mode} not found`)
    }
    listeners.remove(owner, listener)
}

export function createV2ChatOutputApi(listeners: PluginChatOutputListeners) {
    return {
        addRisuChatListener(mode: string, listener: ChatOutputListener) {
            addOwnedChatOutputListener(listeners, V2_CHAT_OUTPUT_OWNER, mode, listener)
        },
        removeRisuChatListener(mode: string, listener: ChatOutputListener) {
            removeOwnedChatOutputListener(listeners, V2_CHAT_OUTPUT_OWNER, mode, listener)
        },
    }
}

export async function dispatchCommittedChatOutput(
    listeners: PluginChatOutputListeners,
    output: ChatOutputListenerArg,
) {
    if (output.messageIndex < 0 || !output.chat?.message?.[output.messageIndex]) {
        return
    }
    await listeners.dispatch(output)
}

export async function readInlayWithPermission<T>(
    hasPermission: () => Promise<boolean>,
    read: () => Promise<T | null>,
): Promise<T | null> {
    if (!await hasPermission()) {
        return null
    }
    return await read()
}
