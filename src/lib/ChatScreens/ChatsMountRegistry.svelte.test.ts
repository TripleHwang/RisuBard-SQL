import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'

import Chats from './Chats.svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'
import {
    getMountedMessageCount,
    isMessageMounted,
    resetMountedMessageRegistryForTesting,
} from 'src/ts/chatMountRegistry'

/**
 * Storage-side residency trimming refuses to release any message this screen
 * has mounted, and it learns what those are from the mount registry. The
 * refusal is only worth anything if the registry actually describes what is on
 * screen, so this mounts the real component and compares the registry against
 * the rows it really put in the DOM -- not against what the source says it
 * intends to do.
 */

function buildMessages(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        chatId: `m-${index}`,
        role: index % 2 === 0 ? 'user' : 'char',
        data: `message ${index}`,
    })) as any[]
}

function buildCharacter(messages: any[]) {
    return {
        chaId: 'character-1',
        name: 'Tester',
        type: 'character',
        image: '',
        chatPage: 0,
        chats: [{ id: 'chat-1', name: 'chat', note: '', localLore: [], message: messages }],
        alternateGreetings: [],
        firstMessage: 'hi',
        emotionImages: [],
        customscript: [],
        globalLore: [],
    } as any
}

let mounted: ReturnType<typeof mount> | null = null
let host: HTMLDivElement | null = null

afterEach(() => {
    if (mounted) unmount(mounted)
    mounted = null
    host?.remove()
    host = null
    resetMountedMessageRegistryForTesting()
})

function render(messages: any[]) {
    const currentCharacter = buildCharacter(messages)
    DBState.db.characters = [currentCharacter]
    selectedCharID.set(0)
    host = document.createElement('div')
    document.body.appendChild(host)
    mounted = mount(Chats, {
        target: host,
        props: {
            messages,
            currentCharacter,
            onReroll: () => {},
            unReroll: () => {},
            currentUsername: 'user',
            userIcon: '',
        },
    })
    flushSync()
    return host
}

describe('the mount registry describes what the chat screen actually mounted', () => {
    it('publishes exactly the rows present in the DOM', () => {
        const messages = buildMessages(400)
        const container = render(messages)

        const rows = Array.from(container.querySelectorAll('[data-chat-row]'))
            .map(element => element.getAttribute('data-chat-row')!)

        expect(rows.length).toBeGreaterThan(0)
        expect(getMountedMessageCount()).toBe(rows.length)
        for (const id of rows) expect(isMessageMounted(id)).toBe(true)
        // And nothing beyond them: a registry that over-reports would pin the
        // whole history resident and quietly defeat the bound.
        const published = new Set(rows)
        for (const message of messages) {
            if (!published.has(message.chatId)) expect(isMessageMounted(message.chatId)).toBe(false)
        }
    })

    it('reports nothing once the screen is destroyed', () => {
        render(buildMessages(120))
        expect(getMountedMessageCount()).toBeGreaterThan(0)

        unmount(mounted!)
        mounted = null

        // A screen that is gone is holding nothing on screen. Leaving its rows
        // behind would pin them resident for the rest of the session.
        expect(getMountedMessageCount()).toBe(0)
    })
})
