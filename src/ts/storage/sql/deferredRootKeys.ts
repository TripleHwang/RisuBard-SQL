/**
 * Client-side registry of root keys that are KNOWN TO EXIST in storage but have
 * not been loaded into the in-memory `Database` yet.
 *
 * The invariant this module exists to enforce: "not loaded" and "not present"
 * are different states, and only "not present" may ever produce a delete.
 * Everything that turns absence into a definite negative conclusion -- the
 * dirty-commit builder's `undefined -> DELETE` rule, the compatibility audit's
 * `absent from the object -> the key changed` rule -- has to consult this first.
 *
 * Deliberately a plain module-level `Set`, NOT `$state`. Svelte's `proxy()`
 * (node_modules/svelte/src/internal/client/proxy.js:48-50) returns any value
 * whose prototype is neither `Object.prototype` nor `Array.prototype`
 * untouched, so `$state(new Set())` is left unproxied and its mutations signal
 * nothing. A silently non-reactive guard would be worse than no guard: it would
 * read as reactive at every call site while failing to notify anything.
 */

import { resetPluginStorageOverlay } from './pluginStorageOverlay'

const deferredKeys = new Set<string>()

export type DeferredRootDeleteRefusal = {
    key: string
    /** Where the refusal happened, e.g. 'buildSqlDirtyCommit'. */
    origin: string
}

const refusals: DeferredRootDeleteRefusal[] = []

/** Record that `keys` exist in storage but are not resident in memory yet. */
export function markRootKeysDeferred(keys: Iterable<string>): void {
    for (const key of keys) {
        if (!key) continue
        deferredKeys.add(key)
    }
}

/** Record a single root key as existing in storage but not resident in memory. */
export function markRootKeyDeferred(key: string): void {
    if (!key) return
    deferredKeys.add(key)
}

/**
 * Called once a key's real value has been written into the in-memory database.
 * After this the key is fully known again and absence means absence.
 */
export function clearDeferredRootKey(key: string): void {
    deferredKeys.delete(key)
}

/** True while `key` is known to exist in storage but is not loaded in memory. */
export function isRootKeyDeferred(key: string): boolean {
    return deferredKeys.has(key)
}

/** Snapshot of the currently deferred keys, for diagnostics and tests. */
export function deferredRootKeySnapshot(): string[] {
    return [...deferredKeys].sort()
}

export function deferredRootKeyCount(): number {
    return deferredKeys.size
}

/**
 * Loud, explicitly named refusal. A deferred key reaching a delete site means
 * some upstream audit or diff concluded "changed"/"gone" from partial
 * knowledge, which is a bug there and not here. We refuse the delete, keep the
 * rest of the commit intact, and make the refusal impossible to miss: the
 * console gets an error, and the refusal is retained so tests and diagnostics
 * can assert on it without spying on the console.
 *
 * This does NOT throw. Throwing here would abort the whole dirty commit, and
 * because `commitDirtyScopes` retries a failed flush forever, one upstream bug
 * would permanently block persistence of every unrelated change -- reproducing
 * the same class of data loss this guard exists to prevent, in a new shape.
 */
export function refuseDeferredRootDelete(key: string, origin: string): void {
    refusals.push({ key, origin })
    console.error(
        `[SQL deferred root guard] ${origin} refused to delete root key "${key}": ` +
        'it is deferred (known to exist in storage, not loaded into memory), so its ' +
        'absence from the in-memory database is not evidence that it was deleted. ' +
        'Whatever marked it dirty concluded a deletion from partial knowledge and is the actual bug.',
    )
}

/** Refusals recorded so far, oldest first. */
export function deferredRootDeleteRefusals(): readonly DeferredRootDeleteRefusal[] {
    return refusals
}

/** Full reset. Re-bootstrap and tests both need this. */
export function resetDeferredRootKeys(): void {
    deferredKeys.clear()
    refusals.length = 0
    // The per-key plugin storage overlay only means anything while
    // `pluginCustomStorage` is deferred; it caches values read from a store this
    // reset says we are starting over on. Left behind, it would answer the next
    // session's reads from the previous database. Imported for its state only --
    // the module has no imports of its own, so this closes no cycle.
    resetPluginStorageOverlay()
}
