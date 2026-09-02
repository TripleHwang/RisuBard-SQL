import type { Chat } from "./database.svelte"
import { isSqlWindowPartial } from "./sql/sqlRuntimeWindow"

/**
 * True when the in-memory message array is not the canonical full history.
 *
 * The single predicate the app asks before it does anything that treats
 * `chat.message` as the whole conversation -- above all `saveChatToServer`,
 * which would otherwise replace the server's full history with whatever slice
 * happens to be resident.
 *
 * It lives in its own module, apart from `chatStorage.ts`, only so that it can
 * be imported by tests and by code that must not drag in the storage layer's
 * whole dependency graph (`chatStorage` reaches `globalApi`, which reaches the
 * DOM). `chatStorage` re-exports it, so every existing import site is
 * unchanged and there is still exactly one implementation.
 */
export function isChatHistoryIncomplete(chat: Chat | null | undefined): boolean {
    if (!chat || chat._placeholder) return true
    const runtime = chat as Chat & {
        messagesLoaded?: boolean
        messagesFullyLoaded?: boolean
    }
    return runtime.messagesLoaded === false || runtime.messagesFullyLoaded === false || isSqlWindowPartial(chat)
}
