/**
 * Per-key plugin storage, for when the whole map is never loaded at all.
 *
 * `pluginCustomStorage` is the one root key this build withholds from the SQL
 * bootstrap, and `loadPlugins` has always paid it back in full: one
 * `GET /api/sql/root-keys/pluginCustomStorage` before any plugin code runs. On
 * the stores this deferral exists for -- long-term-memory plugins reaching
 * hundreds of megabytes -- that single fetch is the startup cost, and the
 * resident map it produces is what the idle compatibility audit then
 * re-fingerprints every five seconds forever.
 *
 * This module is the alternative: read one key when one key is asked for, and
 * leave `db.pluginCustomStorage` absent.
 *
 * WHY IT IS NOT ALWAYS ON. The v2.0/v2.1 plugin API is synchronous --
 * `pluginStorage.getItem(key)` returns the value, it does not return a promise
 * -- and a synchronous function cannot wait for HTTP. There is no transform
 * that fixes this: rewriting a call site to `await` is only valid where it is
 * already async, and `arr.map(k => storage.getItem(k))` would silently start
 * yielding promises. So per-key mode is entered only when every enabled plugin
 * uses the v3 API, whose storage calls cross a `postMessage` bridge and are
 * asynchronous by construction. `plugins.svelte.ts` decides that from the
 * `version` recorded on each plugin, before a line of plugin code runs.
 *
 * WHY `db.pluginCustomStorage` STAYS ABSENT. Every whole-map reader in the
 * application -- the dirty-commit builder, the compatibility audit, the delta
 * builder, the asset scan, local backup, the storage viewer, the lorebook
 * workspace -- consults `isRootKeyDeferred('pluginCustomStorage')` and either
 * awaits a full hydrate or refuses. A partially populated map would defeat all
 * of them at once: each would read the keys it happened to find as the complete
 * set. So values read per key are cached HERE, and the deferred mark stays up.
 *
 * WHY THE WRITE SIDE MATTERS MORE THAN THE READ SIDE. `markSqlPluginStorageDirty`
 * has exactly one caller in the application: the idle compatibility audit, which
 * finds writes by re-fingerprinting the whole resident map. With the map never
 * resident, that detector sees nothing -- so in per-key mode a write that is not
 * marked at the moment it happens is a write that is never persisted. Every
 * mutator here marks, and `buildSqlDirtyCommit` sources the value it commits
 * from this overlay when the map is deferred. That is the load-bearing pair.
 *
 * Deliberately dependency-free: `sqlDirtyCommit`, `sqlRuntimeHydration` and the
 * plugin runtime all import it, and an import edge back into any of them would
 * close a cycle.
 */

/**
 * What this overlay knows about one key.
 *
 * `present: false` is a real, positive fact -- either the server answered that
 * the row is not stored, or a plugin removed it in this session. It is never
 * the state of "we have not looked", which is simply the absence of an entry.
 * Collapsing the two is how a plugin gets told it has no data and writes over
 * what it has.
 */
export type PluginStorageOverlayEntry =
    | { present: true; value: unknown }
    | { present: false }

let perKeyMode = false

/** Values read or written per key while the whole map is not resident. */
const overlay = new Map<string, PluginStorageOverlayEntry>()

/**
 * The complete key list, once fetched.
 *
 * `null` means "not fetched", never "empty". Enumeration -- `keys()`,
 * `length()`, `key(index)`, `clear()` -- is all-or-nothing: each of those means
 * "this is all of them" at the call site, so answering from the overlay alone
 * would report the handful of keys this session happened to touch as the user's
 * entire plugin storage.
 */
let knownKeys: Set<string> | null = null

/** True while plugin storage is being served one key at a time. */
export function isPluginStoragePerKeyMode(): boolean {
    return perKeyMode
}

/**
 * Enter per-key mode. Called only by the plugin loader, and only once it has
 * established that no enabled plugin can reach the synchronous storage API.
 */
export function enablePluginStoragePerKeyMode(): void {
    perKeyMode = true
}

/**
 * Leave per-key mode and hand back everything this overlay is holding.
 *
 * Called when the whole map is hydrated after all -- the storage viewer, a
 * local backup, a v3 plugin asking for the whole database. The returned entries
 * must be applied ON TOP of the map that just arrived: a key written in this
 * session and not yet flushed is newer than the row the server just sent, and
 * dropping it here would lose the write with no error anywhere.
 */
export function drainPluginStorageOverlay(): Map<string, PluginStorageOverlayEntry> {
    const drained = new Map(overlay)
    perKeyMode = false
    overlay.clear()
    knownKeys = null
    return drained
}

/** What the overlay knows about `key`, or `undefined` for "not looked at". */
export function readPluginStorageOverlay(key: string): PluginStorageOverlayEntry | undefined {
    return overlay.get(key)
}

/**
 * Record what a per-key read found, including a definite "not stored".
 *
 * Refuses once per-key mode has ended, and that refusal is the point. A read
 * issued while the mode was on can still be in flight when
 * `ensureRootKeyHydrated` drains this overlay and installs the whole map; its
 * answer arrives afterwards, into an overlay nothing will ever drain again.
 * Left there it is stale the moment the map changes, and the commit builder
 * that consults the overlay for a key missing from the map would read it as the
 * truth -- turning a later `removeItem` into an upsert of the value from before
 * the removal. The read itself is unaffected: the caller returns what the
 * server said, it simply is not remembered here.
 */
export function cachePluginStorageOverlay(key: string, entry: PluginStorageOverlayEntry): void {
    if (!key || !perKeyMode) return
    overlay.set(key, entry)
    if (knownKeys) {
        if (entry.present) knownKeys.add(key)
        else knownKeys.delete(key)
    }
}

/**
 * Record a write. The caller marks the key dirty; this only holds the value so
 * that the next read and the next commit both see it.
 */
export function writePluginStorageOverlay(key: string, value: unknown): void {
    if (!key) return
    overlay.set(key, { present: true, value })
    knownKeys?.add(key)
}

/** Record a removal as a definite absence, so a later read does not refetch it. */
export function removePluginStorageOverlay(key: string): void {
    if (!key) return
    overlay.set(key, { present: false })
    knownKeys?.delete(key)
}

/** The full key list if it has been fetched, `null` if it has not. */
export function pluginStorageKnownKeys(): string[] | null {
    return knownKeys ? [...knownKeys].sort() : null
}

/**
 * Install the complete key list fetched from storage, then fold in what this
 * session already knows.
 *
 * The server's list is a snapshot from before this session's unflushed writes,
 * so a key written here but not yet committed is missing from it and a key
 * removed here is still in it. Applying the overlay on top is what keeps
 * enumeration consistent with the reads and writes the same plugin just made.
 */
export function setPluginStorageKnownKeys(keys: Iterable<string>): void {
    // Same reason as `cachePluginStorageOverlay`: a key list fetched while the
    // mode was on can land after the map has been installed, and this overlay
    // is no longer the place anything reads keys from. The caller returns the
    // fetched list regardless, so enumeration still answers with every key.
    if (!perKeyMode) return
    const next = new Set(keys)
    for (const [key, entry] of overlay) {
        if (entry.present) next.add(key)
        else next.delete(key)
    }
    knownKeys = next
}

/**
 * Mark every stored key as removed, for `pluginStorage.clear()`.
 *
 * Takes the full key list as an argument rather than reading it, so the caller
 * is forced to have fetched it first: a clear that only removed the keys this
 * session touched would leave the rest of the store behind while telling the
 * plugin it was emptied.
 */
export function clearPluginStorageOverlay(allKeys: Iterable<string>): string[] {
    // The union of what storage holds and what this session wrote. The second
    // half matters: a key written in this session and not yet flushed is not in
    // the server's list, and leaving it out would mean `clear()` removed
    // everything except the rows the plugin had just added.
    const cleared = new Set([...allKeys, ...overlay.keys()])
    for (const key of cleared) overlay.set(key, { present: false })
    knownKeys = new Set()
    return [...cleared]
}

/** Full reset, for re-bootstrap and tests. */
export function resetPluginStorageOverlay(): void {
    perKeyMode = false
    overlay.clear()
    knownKeys = null
}
