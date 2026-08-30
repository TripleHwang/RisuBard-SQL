import { flushSync, mount, unmount } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'

import BookmarkList from './BookmarkList.svelte'
import { DBState, selectedCharID } from 'src/ts/stores.svelte'

/**
 * Expanding one bookmark is a `Set` mutation the template reads directly:
 * `{#if expandAll || expandedBookmarks.has(msg.chatId)}`.
 *
 * `reactiveCollections.svelte.test.ts` pins the runtime rule that makes that
 * work -- Svelte's `proxy()` returns built-in collections untouched, so
 * `$state(new Set())` signals only on reassignment -- but it never mounts this
 * component, so nothing there fails if the component goes back to a plain
 * `Set`. This does mount it, and clicks the row the user clicks. Swap
 * `SvelteSet` for `new Set` in BookmarkList.svelte and the body never appears.
 */

function characterWithBookmark() {
    return {
        chaId: 'character-1',
        name: 'Tester',
        type: 'character',
        image: '',
        chatPage: 0,
        chats: [{
            id: 'chat-1',
            name: 'chat',
            note: '',
            localLore: [],
            message: [
                { chatId: 'm-0', role: 'char', data: 'first bookmarked message' },
                { chatId: 'm-1', role: 'user', data: 'second message' },
            ],
            bookmarks: ['m-0'],
            bookmarkNames: {},
        }],
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
})

/** The panel body that only exists while that bookmark is expanded. */
const expandedBodies = (root: ParentNode) => root.querySelectorAll('.border-t.border-darkborderc')

describe('expanding a bookmark', () => {
    it('renders the message body when the row is clicked', () => {
        DBState.db.characters = [characterWithBookmark()]
        selectedCharID.set(0)
        host = document.createElement('div')
        document.body.appendChild(host)
        mounted = mount(BookmarkList, { target: host })
        flushSync()

        // The bookmarked row is listed, and nothing is expanded yet.
        const row = host.querySelector('[role="button"]') as HTMLElement | null
        expect(row).not.toBeNull()
        expect(expandedBodies(host)).toHaveLength(0)

        // The mutation under test: `expandedBookmarks.add(chatId)`, in place.
        row!.click()
        flushSync()
        expect(expandedBodies(host)).toHaveLength(1)

        // And `.delete` in place has to reach the template just as well, or a
        // row could be opened and never closed again.
        row!.click()
        flushSync()
        expect(expandedBodies(host)).toHaveLength(0)
    })
})
