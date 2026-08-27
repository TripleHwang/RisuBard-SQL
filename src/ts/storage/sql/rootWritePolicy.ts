// @ts-ignore - plain CJS module shared verbatim with server/node/relational-sqlite.cjs;
// see that file's DEFERRED_BOOTSTRAP_KEYS usage for the other consumer. Lives under
// server/node/ (not a top-level shared/) so every packaging path that ships the
// server also ships this file -- same arrangement as server/node/assetOwnership.cjs.
import { DEFERRED_BOOTSTRAP_KEY_LIST } from "../../../../server/node/deferredBootstrapKeys.cjs";

/**
 * Root keys the dirty-commit builder is never allowed to turn into a
 * `DELETE FROM system_settings` purely because the in-memory value went
 * missing.
 *
 * Why these keys and not "all of them": `setting_extension_nodes.setting_key`
 * declares `REFERENCES system_settings(key) ON DELETE CASCADE`
 * (server/node/relational-schema.sql), so deleting one root row destroys the
 * entire serialized tree underneath it with no tombstone and no backup. For a
 * scalar preference that is a nuisance (it re-defaults). For a collection the
 * user authored or installed by hand it is unrecoverable.
 *
 * The list is therefore exactly "collections of user-authored or
 * user-installed content, plus the structures that organize them":
 *
 *   plugins, pluginV2          installed plugin source + per-plugin config;
 *                              the reported wipe. Re-obtaining them means
 *                              re-finding every plugin URL by hand.
 *   personas                   user personas (name, prompt, icon asset refs).
 *   modules, moduleFolders     user modules (bundled lorebooks/scripts/assets)
 *                              and the folder tree that organizes them.
 *   enabledModules,            which modules are active, globally and per
 *   personaEnabledModules      persona. Not derivable from anything else.
 *   loreBook                   global lorebooks.
 *   prompts, promptCollections authored prompt templates/collections.
 *   promptTemplate             the active authored prompt template.
 *   loadouts,                  saved configuration loadouts and the pointer
 *   lastLoadedLoadoutName      to the one in use.
 *   globalscript, customScripts, scripts
 *                              authored regex/JS scripts.
 *   translatorPresets          authored translator presets.
 *   themePresets, togglePresets, personaBuilderPromptPresets
 *                              authored preset collections.
 *   customSidebarItems         authored sidebar entries.
 *   customSounds               user-registered sound assets.
 *   characterOrder             the character folder tree. The characters
 *                              themselves live in their own table, but this
 *                              key is the ONLY record of the user's foldering
 *                              and losing it flattens the whole library.
 *   characterVault             vault state.
 *
 * `characters`, `botPresets`, `botPresetsId` and `pluginCustomStorage` are
 * absent on purpose: they never reach the root-key path at all (see
 * ROOT_EXCLUSIONS in sqlDirtyCommit.ts) because they have dedicated tables.
 *
 * SAFETY asymmetry, same as server/node/assetOwnership.cjs: a key wrongly on
 * this list leaves one stale row in `system_settings` until something writes
 * a real value over it. A key wrongly OFF it is unrecoverable data loss. When
 * in doubt, add it.
 */
export const NEVER_IMPLICITLY_DELETE: ReadonlySet<string> = new Set([
    "plugins",
    "pluginV2",
    "personas",
    "modules",
    "moduleFolders",
    "enabledModules",
    "personaEnabledModules",
    "loreBook",
    "prompts",
    "promptCollections",
    "promptTemplate",
    "loadouts",
    "lastLoadedLoadoutName",
    "globalscript",
    "customScripts",
    "scripts",
    "translatorPresets",
    "themePresets",
    "togglePresets",
    "personaBuilderPromptPresets",
    "customSidebarItems",
    "customSounds",
    "characterOrder",
    "characterVault",
]);

/**
 * Root keys the standalone Node server deliberately withholds from
 * `/api/sql/bootstrap`. Mirrors the server list by IMPORT, never by copy.
 */
export const DEFERRED_ROOT_KEYS: ReadonlySet<string> = new Set(
    DEFERRED_BOOTSTRAP_KEY_LIST as readonly string[],
);

// ── Deferred-hydration gate ────────────────────────────────────────────────
//
// `db.plugins` being `undefined` has two completely different meanings:
//
//   (a) "not loaded yet"  -- the fast bootstrap withheld it and
//                            `hydrateDeferredDatabase()` has not landed.
//   (b) "genuinely gone"  -- something removed the key after it was loaded.
//
// Nothing about the VALUE can tell those apart, so the value is not what we
// inspect. Instead the storage backend that defers keys ARMS this gate the
// moment it is constructed, and only its own `hydrateDeferredDatabase()`
// disarms it, reporting exactly which keys the server actually returned.
// Until then every deferred key is unwritable in either direction -- no
// upsert, no delete -- which is what makes correctness stop depending on the
// order of calls in bootstrap.ts.
//
// Backends that do not defer anything (WebSqliteStorage) never arm the gate,
// so it reports ready and this whole mechanism is inert for them.

let deferredGateArmed = false;
let deferredHydrationApplied = false;
let appliedDeferredKeys: ReadonlySet<string> = new Set<string>();

/** Declares that deferred keys will be withheld until hydration lands. */
export function armDeferredRootWriteGate(): void {
    deferredGateArmed = true;
}

/** Records the deferred keys a completed hydration actually applied. */
export function markDeferredRootHydrationApplied(keys: Iterable<string>): void {
    appliedDeferredKeys = new Set(keys);
    deferredHydrationApplied = true;
}

/**
 * True when deferred root keys may be written. Unarmed backends are always
 * ready; an armed backend is ready only after a hydration reported back.
 */
export function isDeferredRootHydrationReady(): boolean {
    return !deferredGateArmed || deferredHydrationApplied;
}

/**
 * The deferred keys the last hydration actually carried. A deferred key
 * absent from this set simply has no row on the server yet (a first-ever
 * plugin install, for instance) -- which is why readiness is a single flag
 * rather than a per-key check: gating per key would make the first write to a
 * never-before-stored key impossible.
 */
export function getAppliedDeferredRootKeys(): ReadonlySet<string> {
    return appliedDeferredKeys;
}

export function resetDeferredRootWriteGateForTesting(): void {
    deferredGateArmed = false;
    deferredHydrationApplied = false;
    appliedDeferredKeys = new Set<string>();
    explicitRootDeletions.clear();
}

// ── Explicit deletion intent ───────────────────────────────────────────────

const explicitRootDeletions = new Set<string>();

/**
 * Declares that the caller really does mean to remove a protected root key
 * from the database entirely (as opposed to storing an empty collection).
 * Consumed by the next commit that sees the key absent.
 */
export function requestRootDeletion(key: string): void {
    explicitRootDeletions.add(key);
}

function consumeRootDeletionIntent(key: string): boolean {
    return explicitRootDeletions.delete(key);
}

// ── Planning ───────────────────────────────────────────────────────────────

export type RootWritePlan =
    | { action: "upsert"; value: unknown }
    | { action: "delete" }
    | { action: "skip"; reason: RootWriteSkipReason };

export type RootWriteSkipReason =
    | "deferred-not-hydrated"
    | "protected-key-absent";

let warnedSkips = new Set<string>();

export function resetRootWriteWarningsForTesting(): void {
    warnedSkips = new Set<string>();
}

function warnOnce(key: string, reason: RootWriteSkipReason): void {
    const token = `${reason} ${key}`;
    if (warnedSkips.has(token)) return;
    warnedSkips.add(token);
    console.warn(
        reason === "deferred-not-hydrated"
            ? `[sql] refusing to write root key "${key}" before deferred hydration landed; the in-memory value is not the stored value yet.`
            : `[sql] root key "${key}" vanished from the database without an explicit deletion request; refusing to emit a cascading DELETE for user content.`,
    );
}

/**
 * Decides what a dirty root key should do to `system_settings`.
 *
 * The empty-collection case is deliberately NOT blocked: "the user removed
 * their last plugin" is a real action and must persist. It is separated from
 * "not loaded yet" by the hydration gate above, not by inspecting the value --
 * once hydration has landed, whatever sits in `db.plugins` is what the user
 * has, including `[]`. Before hydration nothing about a deferred key is
 * writable at all, so a client-materialised `[]` can never reach the database.
 */
export function planRootWrite(
    database: Record<string, unknown>,
    key: string,
): RootWritePlan {
    if (DEFERRED_ROOT_KEYS.has(key) && !isDeferredRootHydrationReady()) {
        warnOnce(key, "deferred-not-hydrated");
        return { action: "skip", reason: "deferred-not-hydrated" };
    }

    const value = database[key];
    const missing =
        !Object.prototype.hasOwnProperty.call(database, key) ||
        value === undefined ||
        typeof value === "function";
    if (!missing) return { action: "upsert", value };

    if (NEVER_IMPLICITLY_DELETE.has(key)) {
        if (consumeRootDeletionIntent(key)) return { action: "delete" };
        warnOnce(key, "protected-key-absent");
        return { action: "skip", reason: "protected-key-absent" };
    }
    return { action: "delete" };
}
