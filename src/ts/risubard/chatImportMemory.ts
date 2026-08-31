import type { Chat } from '../storage/database.svelte'

export function resetImportedBardWikiState(chat: Chat): void {
    for (const message of chat.message) {
        delete message.risubardMemoryConfirmed
        delete message.risubardCanonicalReceipt
    }
    delete chat.risuBardLastAutosaveTurn
    delete chat.risuBardWikiReboot
}
