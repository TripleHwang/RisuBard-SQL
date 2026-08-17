import type { loreBook } from 'src/ts/storage/database.svelte'
export {
    ensureGlobalLorebookPageIds,
    ensureStableLorebookOwnerId,
} from 'src/ts/lorebook/ownerIdentity'

type CoreLorebookScope =
    | { kind: 'character'; chaId: string }
    | { kind: 'chat'; chaId: string; chatId: string }
    | { kind: 'global-page'; pageId: string }
    | { kind: 'module'; moduleId: string }

type LoremasterScope =
    | { kind: 'character'; chaId: string }
    | { kind: 'chat'; chaId: string; chatId: string }

type LegacyLorebook = loreBook & { disabled?: boolean }
type ModuleLorebookOwner = { id: string; lorebook?: loreBook[] }
type LocalActivationChatOwner = { localLore?: loreBook[] }
type LocalActivationCharacterOwner<Chat extends LocalActivationChatOwner> = { chats: Chat[] }

export interface LorebookLocalActivation {
    visible: boolean
    isActive: (entry: loreBook) => boolean
    onToggle: (entry: loreBook, active: boolean) => void
    onEntriesRemoved?: (ids: string[]) => void
}

export function createCharacterLocalActivationBinding<
    Chat extends LocalActivationChatOwner,
    Character extends LocalActivationCharacterOwner<Chat>,
>(
    character: Character,
    chat: Chat,
    visible: boolean,
    getCharacters: () => Character[],
): LorebookLocalActivation {
    const isAvailable = () => getCharacters().includes(character) && character.chats.includes(chat)
    const isActive = (entry: loreBook) => Boolean(
        entry.id
        && isAvailable()
        && chat.localLore?.some((item) => item.id === entry.id && item.mode === 'child')
    )
    return {
        visible,
        isActive,
        onToggle(entry, active) {
            if (!entry.id || !isAvailable()) return
            if (active) {
                if (isActive(entry)) return
                const childLore: loreBook = {
                    key: '',
                    comment: '',
                    content: '',
                    mode: 'child',
                    insertorder: 100,
                    alwaysActive: true,
                    secondkey: '',
                    selective: false,
                    id: entry.id,
                }
                chat.localLore = [...(chat.localLore ?? []), childLore]
                return
            }
            chat.localLore = (chat.localLore ?? []).filter(
                (item) => item.id !== entry.id || item.mode !== 'child'
            )
        },
        onEntriesRemoved(ids) {
            if (!isAvailable() || ids.length === 0) return
            const removedIds = new Set(ids)
            for (const ownerChat of character.chats) {
                if (!ownerChat.localLore) continue
                ownerChat.localLore = ownerChat.localLore.filter(
                    (item) => item.mode !== 'child' || !item.id || !removedIds.has(item.id)
                )
            }
        },
    }
}

export function createLorebookOwnerBinding<Owner extends object>(
    owner: Owner,
    entries: loreBook[],
    replace: (owner: Owner, next: loreBook[]) => void,
    isAvailable: (owner: Owner) => boolean = () => true,
) {
    return {
        owner,
        entries,
        onChange(next: loreBook[]): void {
            if (isAvailable(owner)) replace(owner, next)
        },
    }
}

export function coreLorebookScopeKey(scope: CoreLorebookScope): string {
    switch (scope.kind) {
        case 'character': return JSON.stringify(['lorebook', 'character', scope.chaId])
        case 'chat': return JSON.stringify(['lorebook', 'chat', scope.chaId, scope.chatId])
        case 'global-page': return JSON.stringify(['lorebook', 'global-page', scope.pageId])
        case 'module': return JSON.stringify(['lorebook', 'module', scope.moduleId])
    }
}

export async function importLorebooksIntoModule(
    targetModule: ModuleLorebookOwner,
    getCurrentModule: () => ModuleLorebookOwner,
    selectFiles: () => Promise<Array<{ data: Uint8Array }> | null | undefined>,
    parseFile: (data: Uint8Array) => loreBook[],
): Promise<boolean> {
    const targetId = targetModule.id
    const files = await selectFiles()
    if (!files || getCurrentModule() !== targetModule || targetModule.id !== targetId) return false
    const imported = files.flatMap((file) => parseFile(file.data))
    targetModule.lorebook = [...(targetModule.lorebook ?? []), ...imported]
    return true
}

export function loremasterDisabledBackupKey(scope: LoremasterScope): string {
    return scope.kind === 'character'
        ? `loremaster:disabled:character:${scope.chaId}`
        : `loremaster:disabled:chat:${scope.chaId}:${scope.chatId}`
}

export function readLoremasterDisabledBackups(
    storage: Record<string, unknown> | null | undefined,
    key: string,
): Record<string, LegacyLorebook> | undefined {
    const value = storage?.[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    return value as Record<string, LegacyLorebook>
}

export function resolveCharacterGlobalLoreLabel(
    entries: loreBook[],
    id: string,
): string | undefined {
    const entry = entries.find((item) => item.id === id)
    if (!entry) return undefined
    return entry.comment.trim() || entry.key.trim() || undefined
}
