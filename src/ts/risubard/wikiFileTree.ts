import type { MarkdownWikiDocumentType } from './memoryWiki'

export interface WikiTreeDocumentInput {
    id: string
    title: string
    relativePath: string
    type: MarkdownWikiDocumentType
    status?: 'active' | 'superseded' | 'retracted'
    created?: string
}

export type WikiFileTreeNode = {
    kind: 'folder'
    name: string
    path: string
    readOnly: boolean
    children: WikiFileTreeNode[]
} | {
    kind: 'file'
    name: string
    path: string
    readOnly: boolean
    documentId: string
    title: string
    created?: string
}

const standardWikiFolders = [
    'characters',
    'locations',
    'factions',
    'items',
    'concepts',
    'notes',
    'events',
] as const

export function buildWikiFileTree(
    documents: readonly WikiTreeDocumentInput[]
): WikiFileTreeNode[] {
    const roots = new Map<string, WikiFileTreeNode>()
    for (const name of standardWikiFolders) {
        roots.set(name, {
            kind: 'folder',
            name,
            path: name,
            readOnly: name === 'events',
            children: [],
        })
    }
    for (const document of documents) {
        if (document.type === 'event' && document.status === 'retracted') {
            continue
        }
        const parts = document.relativePath.split('/').filter(Boolean)
        if (parts.length === 0) continue
        const readOnly = document.type === 'event'
        if (parts.length === 1) {
            roots.set(document.relativePath, {
                kind: 'file',
                name: parts[0],
                path: document.relativePath,
                readOnly,
                documentId: document.id,
                title: document.title,
                created: document.created,
            })
            continue
        }
        const folderName = parts[0]
        const folderPath = folderName
        let folder = roots.get(folderPath)
        if (!folder || folder.kind !== 'folder') {
            folder = {
                kind: 'folder',
                name: folderName,
                path: folderPath,
                readOnly: folderName === 'events',
                children: [],
            }
            roots.set(folderPath, folder)
        }
        folder.children.push({
            kind: 'file',
            name: parts.at(-1) ?? document.relativePath,
            path: document.relativePath,
            readOnly,
            documentId: document.id,
            title: document.title,
            created: document.created,
        })
    }
    const order = (node: WikiFileTreeNode) => node.kind === 'file' ? 0 : 1
    const sorted = [...roots.values()].sort((left, right) =>
        order(left) - order(right) || left.name.localeCompare(right.name)
    )
    for (const node of sorted) {
        if (node.kind === 'folder') {
            node.children.sort((left, right) => {
                if (node.path === 'events'
                    && left.kind === 'file'
                    && right.kind === 'file') {
                    const chronological = (right.created ?? '')
                        .localeCompare(left.created ?? '')
                    if (chronological !== 0) return chronological
                }
                return left.name.localeCompare(right.name)
            })
        }
    }
    return sorted
}
