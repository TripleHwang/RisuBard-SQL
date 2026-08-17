export interface LorebookWorkspaceSession {
    activeId: string | null
    selectedIds: string[]
    selectionAnchorId: string | null
    expandedFolderIds: string[]
    listScrollTop: number
    editorScrollTop: number
    focusTarget: string | null
    focusSelectionStart: number | null
    focusSelectionEnd: number | null
    focusedScrollTop: number
}

const sessions = new Map<string, LorebookWorkspaceSession>()

export function readLorebookWorkspaceSession(key: string): LorebookWorkspaceSession | undefined {
    const session = sessions.get(key)
    return session ? structuredClone(session) : undefined
}

export function writeLorebookWorkspaceSession(key: string, session: LorebookWorkspaceSession): void {
    sessions.set(key, structuredClone(session))
}

export function clearLorebookWorkspaceSessions(): void {
    sessions.clear()
}
