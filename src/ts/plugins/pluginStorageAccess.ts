/**
 * The plugin storage seam: which plugin API a plugin uses decides how its
 * storage can be read.
 *
 * Two facts, neither negotiable:
 *
 *  1. The v2.0/v2.1 API is SYNCHRONOUS. `pluginStorage.getItem(key)` returns
 *     the value. A synchronous function cannot wait for a network read, so a
 *     v2 plugin's storage has to already be in memory when it runs. There is no
 *     rewrite that fixes this -- turning a call site into `await` is only valid
 *     where it is already async, and a sync callback (`arr.map(k => get(k))`)
 *     would silently start producing promises instead of values.
 *  2. The v3 API is ASYNCHRONOUS by construction. Every call crosses a
 *     `postMessage` bridge into a sandboxed iframe, and the bridge already
 *     awaits whatever the host function returns. A v3 plugin cannot tell a
 *     value that was in memory from one that was fetched.
 *
 * So per-key laziness is available exactly when no enabled plugin can reach the
 * synchronous surface, and `ProviderPlugin.version` -- recorded on the record by
 * `importPlugin`, readable before any plugin code runs -- is what says so.
 *
 * A record with no `version` is treated as legacy. That is the safe direction
 * and it costs nothing: such a record matches neither of `loadPlugins`'
 * partition filters, so it never executes and never reads storage, but a future
 * change to those filters must not silently turn it into a plugin reading
 * `null` over its own data.
 */

import type { RisuPlugin } from "./plugins.svelte";
import { getActiveSqlStorage } from "../storage/sql/sqlBootstrap";
import type { SqlBootstrapStorage } from "../storage/sql/ISqlStorage";
import { isRootKeyDeferred } from "../storage/sql/deferredRootKeys";
import { markSqlPluginStorageDirty } from "../storage/sql/sqlPersistenceRuntime";
import {
    cachePluginStorageOverlay,
    clearPluginStorageOverlay,
    enablePluginStoragePerKeyMode,
    isPluginStoragePerKeyMode,
    pluginStorageKnownKeys,
    readPluginStorageOverlay,
    removePluginStorageOverlay,
    setPluginStorageKnownKeys,
    writePluginStorageOverlay,
} from "../storage/sql/pluginStorageOverlay";

/**
 * True when this plugin record can reach the synchronous storage API.
 *
 * `'3.0'` is the only answer that means it cannot. Everything else -- `2`,
 * `'2.1'`, the declared-but-unused `1`, and `undefined` on a record written
 * before `version` existed -- is legacy.
 */
export function pluginNeedsResidentStorage(plugin: Pick<RisuPlugin, "version">): boolean {
    return plugin?.version !== "3.0";
}

/**
 * Whether the whole `pluginCustomStorage` map has to be loaded before these
 * plugins run.
 *
 * `'whole'` at least one enabled plugin is legacy; load the entire map, exactly
 *           as this build always has.
 * `'per-key'` every enabled plugin is v3 (including the case of none at all);
 *           serve one key at a time and load nothing up front.
 *
 * An empty list is deliberately `'per-key'` rather than a third "load nothing"
 * plan. The outcome for startup is identical -- nothing is fetched either way --
 * but per-key mode leaves the storage API able to ANSWER if something reaches
 * it later, where "load nothing" would leave the key deferred and every read
 * throwing.
 */
export type PluginStorageLoadPlan = "per-key" | "whole";

export function planPluginStorageLoad(enabledPlugins: readonly Pick<RisuPlugin, "version">[]): PluginStorageLoadPlan {
    return enabledPlugins.some(pluginNeedsResidentStorage) ? "whole" : "per-key";
}

/**
 * Turn per-key mode on, if the backend can serve it.
 *
 * Per-key reads exist only on the standalone server client: the deferral itself
 * is server-mode only (`webSqliteStorage` reads the whole
 * `plugin_custom_storage` table at bootstrap and never defers), so on any other
 * backend the map is already resident and there is nothing to be lazy about.
 * Returns whether the mode was entered, so the caller can fall back to a whole
 * load instead of leaving plugins with a storage API that cannot answer.
 */
export function tryEnablePerKeyPluginStorage(): boolean {
    if (!isRootKeyDeferred("pluginCustomStorage")) return false;
    if (!perKeyStorage()) return false;
    enablePluginStoragePerKeyMode();
    return true;
}

function perKeyStorage(): SqlBootstrapStorage | null {
    const storage = getActiveSqlStorage();
    if (storage?.backendKind !== "server-sql") return null;
    if (typeof (storage as Partial<SqlBootstrapStorage>).readPluginStorageKey !== "function") return null;
    if (typeof storage.listPluginCustomStorageKeys !== "function") return null;
    return storage as SqlBootstrapStorage;
}

function requirePerKeyStorage(action: string): SqlBootstrapStorage {
    const storage = perKeyStorage();
    if (!storage) {
        throw new Error(
            `Plugin storage is being served per key, but no backend can read it, so ${action} ` +
            "cannot be answered. Its rows exist in storage; treating them as absent would destroy them.",
        );
    }
    return storage;
}

/**
 * Normalise a read to exactly what the resident path answers.
 *
 * The resident `pluginStorage.getItem` is `db.pluginCustomStorage[key] || null`,
 * so a stored `0`, `""` or `false` comes back as `null` there. That coercion is
 * a latent bug -- the v3 contract is "stored value or null" and nothing promises
 * it -- but it is TODAY's answer, and this is reproduced deliberately.
 *
 * The alternative is worse than the bug. If per-key mode returned the true `0`
 * while the resident path returned `null`, the same plugin would get different
 * answers depending on whether some unrelated v2.1 plugin happened to be
 * installed, because that is what decides the mode. A plugin cannot be asked to
 * cope with that, and no test it ships could catch it.
 *
 * Fixing the coercion is a worthwhile separate change, and it has to fix BOTH
 * paths in the same commit or it reintroduces exactly this divergence.
 */
function asResidentGetItemAnswer(value: unknown): unknown {
    return value || null;
}

/**
 * One key, fetched if this session has not already seen it.
 *
 * A transport failure REJECTS. It must never resolve to `null`: `null` is the
 * answer a plugin reads as "I have never stored this", and the next thing such
 * a plugin does is write a fresh empty state over the row it could not read.
 * A definite `present: false` from the server is a different fact and is
 * cached, so a genuinely absent key is not refetched on every read.
 */
export async function readPluginStorageKeyLazily(key: string): Promise<unknown> {
    const cached = readPluginStorageOverlay(key);
    if (cached) return cached.present ? asResidentGetItemAnswer(cached.value) : null;
    const storage = requirePerKeyStorage(`pluginStorage.getItem(${JSON.stringify(key)})`);
    const result = await storage.readPluginStorageKey(key);
    cachePluginStorageOverlay(key, result.present ? { present: true, value: result.value } : { present: false });
    return result.present ? asResidentGetItemAnswer(result.value) : null;
}

/**
 * Every key, fetched once per session and then kept in step with local writes.
 *
 * Enumeration is all-or-nothing. `keys()`, `length()`, `key(index)` and
 * `clear()` each mean "this is all of them" where they are called, so answering
 * from the keys this session happened to touch would report a handful of
 * entries as the user's entire plugin storage -- and `clear()` would then
 * delete exactly those and report success.
 */
export async function listPluginStorageKeysLazily(): Promise<string[]> {
    const known = pluginStorageKnownKeys();
    if (known) return known;
    const storage = requirePerKeyStorage("pluginStorage.keys()");
    const fetched = await storage.listPluginCustomStorageKeys();
    setPluginStorageKnownKeys(fetched);
    // The fetched list, not `?? []`. `setPluginStorageKnownKeys` declines if
    // the whole map arrived while this request was in flight, and an empty
    // array here would be exactly the answer this module exists to never give:
    // "your plugin storage has no keys", handed to a `clear()` or a
    // re-initialising plugin.
    return pluginStorageKnownKeys() ?? [...fetched].sort();
}

/**
 * Write one key.
 *
 * The dirty mark is not bookkeeping, it is the whole persistence path. The idle
 * compatibility audit is the ONLY caller of `markSqlPluginStorageDirty` in the
 * application, and it finds writes by re-fingerprinting the resident map -- so
 * with the map never resident it finds nothing, and an unmarked write here is a
 * write that never reaches SQLite. `buildSqlDirtyCommit` reads the value back
 * out of the overlay.
 */
export function writePluginStorageKeyLazily(key: string, value: unknown): void {
    writePluginStorageOverlay(key, value);
    markSqlPluginStorageDirty(key);
}

export function removePluginStorageKeyLazily(key: string): void {
    removePluginStorageOverlay(key);
    markSqlPluginStorageDirty(key);
}

/**
 * Remove every stored key.
 *
 * The key list is fetched first and deliberately not defaulted: clearing only
 * what this session had touched would leave the rest of the store in place
 * while telling the plugin it had been emptied, and the plugin's next write
 * would collide with rows it believes are gone.
 */
export async function clearPluginStorageLazily(): Promise<boolean> {
    const keys = await listPluginStorageKeysLazily();
    // The key-list fetch is the one await in a clear, and the whole map can
    // arrive during it. Once it has, this overlay is drained and dead: writing
    // removals into it would record a deletion nothing reads, the resident map
    // would keep every row, and the plugin would have been told its clear
    // succeeded. Report that it did not happen so the caller runs the resident
    // clear, which is the same operation against the map that now exists.
    if (!isPluginStoragePerKeyMode()) return false;
    for (const key of clearPluginStorageOverlay(keys)) markSqlPluginStorageDirty(key);
    return true;
}

export { isPluginStoragePerKeyMode };
