import type { Message } from '../storage/database.svelte'
import { invokeBrowserFetch } from './browserFetch'

interface SearchableWikiDocument {
    id: string
    title: string
    content: string
}

export interface FindReplacePreview {
    wikiMatches: number
    wikiDocuments: number
    chatMatches: number
    chatMessages: number
}

export function countLiteralMatches(value: string, find: string): number {
    if (!find) return 0
    return value.split(find).length - 1
}

export function previewFindReplace(
    documents: readonly SearchableWikiDocument[],
    messages: readonly Message[],
    find: string
): FindReplacePreview {
    if (!find) {
        return {
            wikiMatches: 0, wikiDocuments: 0,
            chatMatches: 0, chatMessages: 0,
        }
    }
    let wikiMatches = 0
    let wikiDocuments = 0
    for (const document of documents) {
        const matches = countLiteralMatches(document.content, find)
        if (matches === 0) continue
        wikiMatches += matches
        wikiDocuments += 1
    }
    let chatMatches = 0
    let chatMessages = 0
    for (const message of messages) {
        const matches = countLiteralMatches(message.data, find)
            + countLiteralMatches(message.saying ?? '', find)
            + countLiteralMatches(message.name ?? '', find)
            + (message.swipes ?? []).reduce(
                (total, swipe) => total + countLiteralMatches(swipe, find),
                0
            )
        if (matches === 0) continue
        chatMatches += matches
        chatMessages += 1
    }
    return { wikiMatches, wikiDocuments, chatMatches, chatMessages }
}

export function applyChatFindReplace(
    messages: Message[],
    find: string,
    replacement: string
): { matches: number; messages: number } {
    if (!find || find === replacement) return { matches: 0, messages: 0 }
    let matches = 0
    let changedMessages = 0
    for (const message of messages) {
        let messageMatches = countLiteralMatches(message.data, find)
        if (messageMatches > 0) {
            message.data = message.data.replaceAll(find, replacement)
        }
        const sayingMatches = countLiteralMatches(message.saying ?? '', find)
        messageMatches += sayingMatches
        if (sayingMatches > 0 && message.saying !== undefined) {
            message.saying = message.saying.replaceAll(find, replacement)
        }
        const nameMatches = countLiteralMatches(message.name ?? '', find)
        messageMatches += nameMatches
        if (nameMatches > 0 && message.name !== undefined) {
            message.name = message.name.replaceAll(find, replacement)
        }
        if (message.swipes) {
            message.swipes = message.swipes.map((swipe) => {
                const swipeMatches = countLiteralMatches(swipe, find)
                messageMatches += swipeMatches
                return swipeMatches > 0
                    ? swipe.replaceAll(find, replacement)
                    : swipe
            })
        }
        if (messageMatches === 0) continue
        matches += messageMatches
        changedMessages += 1
    }
    return { matches, messages: changedMessages }
}

function bounded(value: string, label: string, maximum: number): string {
    if (typeof value !== 'string' || value.length > maximum) {
        throw new Error(`${label} must contain at most ${maximum} characters`)
    }
    return value
}

export async function replaceWikiText(input: {
    characterId: string
    chatId: string
    find: string
    replacement: string
    fetchImpl: typeof fetch
    createAuth(): Promise<string>
}): Promise<{ matches: number; documents: number }> {
    const body = {
        characterId: bounded(input.characterId.trim(), 'Character ID', 1_024),
        chatId: bounded(input.chatId.trim(), 'Chat ID', 1_024),
        find: bounded(input.find, 'Find text', 256),
        replacement: bounded(input.replacement, 'Replacement text', 256),
    }
    if (!body.characterId || !body.chatId || !body.find) {
        throw new Error('Character ID, chat ID, and find text are required')
    }
    const response = await invokeBrowserFetch(
        input.fetchImpl,
        '/api/risubard/memory/wiki/replace',
        {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'content-type': 'application/json',
                'risu-auth': await input.createAuth(),
            },
            body: JSON.stringify(body),
        }
    )
    if (!response.ok) {
        throw new Error(`Wiki find/replace failed with status ${response.status}`)
    }
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object'
        || !Number.isSafeInteger((value as { matches?: unknown }).matches)
        || !Number.isSafeInteger((value as { documents?: unknown }).documents)) {
        throw new Error('Invalid wiki find/replace receipt')
    }
    return value as { matches: number; documents: number }
}
