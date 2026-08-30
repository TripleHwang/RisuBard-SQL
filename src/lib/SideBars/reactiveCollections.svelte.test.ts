import { describe, expect, test } from 'vitest'
import { flushSync } from 'svelte'
import { SvelteSet } from 'svelte/reactivity'

/**
 * Why this file exists.
 *
 * `BookmarkList.svelte` and `LoreBookList.svelte` both kept UI state in
 * `$state(new Set())`. Svelte's `proxy()` returns built-in collections
 * untouched (svelte/src/internal/client/proxy.js), so a Set held that way has
 * exactly one reactive edge: reassigning the variable. Every `.add`, `.delete`
 * and `.clear` signals nothing.
 *
 * Both components were papering over that -- LoreBookList rebuilt the whole Set
 * after every toggle (`openedRefs = new Set(openedRefs)`), and BookmarkList's
 * `toggleExpandAll` mutated in place with `.clear()` and only looked correct
 * because `expandAll` was reassigned in the same handler. Neither is a property
 * of the components; both are properties of the runtime, so that is what is
 * pinned here.
 *
 * The observers below are `$effect`s, not lazy `$derived` reads, because that
 * is what a component template is: if the mutation does not schedule the
 * effect, the rendered markup does not change. A lazy read would recompute on
 * demand and hide the very failure this is about.
 *
 * This does not mount either component: both need the whole `DBState`
 * character/chat tree and (for LoreBookList) a live SortableJS DOM, and a
 * stubbed stand-in for those would be a fixture that differs from the real
 * input in the way that matters. The components' own correctness rests on this
 * runtime rule plus `svelte-check`.
 *
 * Must stay in a `*.svelte.test.ts` file, or the runes below are never compiled
 * and the assertions prove nothing.
 */

/** Runs `body` inside an effect root, then disposes it. */
function withEffects(body: () => void): void {
    const dispose = $effect.root(body)
    try {
        flushSync()
    } finally {
        dispose()
    }
}

describe('reactive collections in component state', () => {
    test('a plain Set in $state does not re-run an effect that reads it', () => {
        withEffects(() => {
            const store = $state({ set: new Set<string>() })
            const rendered: number[] = []
            $effect(() => { rendered.push(store.set.size) })
            flushSync()
            expect(rendered).toEqual([0])

            // BookmarkList's `toggleExpandAll` and LoreBookList's `onOpen` in
            // miniature: mutate in place, signal nothing.
            store.set.add('bookmark-1')
            flushSync()
            expect(store.set.size).toBe(1)
            expect(rendered).toEqual([0])

            // Only reassignment reaches the effect -- the copy-on-write
            // workaround both components used to carry.
            store.set = new Set(store.set)
            flushSync()
            expect(rendered).toEqual([0, 1])
        })
    })

    test('SvelteSet re-runs the effect on add, delete and clear', () => {
        withEffects(() => {
            const set = new SvelteSet<string>()
            const rendered: string[][] = []
            $effect(() => { rendered.push([...set]) })
            flushSync()
            expect(rendered).toEqual([[]])

            set.add('bookmark-1')
            flushSync()
            set.add('bookmark-2')
            flushSync()
            expect(rendered.at(-1)).toEqual(['bookmark-1', 'bookmark-2'])

            set.delete('bookmark-1')
            flushSync()
            expect(rendered.at(-1)).toEqual(['bookmark-2'])

            // `.clear()` is the mutation BookmarkList's collapse-all path runs.
            set.clear()
            flushSync()
            expect(rendered.at(-1)).toEqual([])
            expect(rendered.length).toBe(5)
        })
    })

    test('SvelteSet membership reads re-run when that entry changes', () => {
        withEffects(() => {
            // `isOpen={openedRefs.has(book)}` in LoreBookList: the read that has
            // to re-run when that one entry is added or removed.
            const set = new SvelteSet<string>()
            const rendered: boolean[] = []
            $effect(() => { rendered.push(set.has('lorebook-1')) })
            flushSync()
            expect(rendered).toEqual([false])

            set.add('lorebook-1')
            flushSync()
            expect(rendered.at(-1)).toBe(true)

            set.delete('lorebook-1')
            flushSync()
            expect(rendered.at(-1)).toBe(false)
        })
    })

    test('$state accepts a SvelteSet and keeps both edges', () => {
        withEffects(() => {
            // The exact declaration both components now use: `$state` still
            // allows reassignment, and the SvelteSet carries the mutations.
            const holder = $state<{ expanded: Set<string> }>({ expanded: new SvelteSet() })
            const rendered: number[] = []
            $effect(() => { rendered.push(holder.expanded.size) })
            flushSync()
            expect(rendered).toEqual([0])

            holder.expanded.add('a')
            flushSync()
            expect(rendered.at(-1)).toBe(1)

            holder.expanded = new SvelteSet(['a', 'b'])
            flushSync()
            expect(rendered.at(-1)).toBe(2)

            holder.expanded.clear()
            flushSync()
            expect(rendered.at(-1)).toBe(0)
        })
    })
})
