import type { Database } from "../database.svelte";

/**
 * Where the SQL layer finds the database the user is actually editing.
 *
 * The application's database is `DBState.db`, a Svelte 5 `$state` proxy. That
 * proxy never writes through to the object it wraps -- `proxy.js`'s `set` trap
 * updates an internal signal and returns, and there is no `Reflect.set` -- so a
 * raw object and its proxy diverge permanently from the moment the proxy is
 * created.
 *
 * Boot creates that divergence by construction. `openExistingStandaloneSql`
 * activates persistence with the object storage returned, and `setDatabase`
 * wraps that same object afterwards. Anything that captured the object at
 * activation is frozen at the instant of boot: every later commit is built from
 * boot-time values, and rows the user added after boot do not exist in it at
 * all. Commits still fire, still return 200, and still write nothing the user
 * did.
 *
 * So nothing in the SQL layer may hold a database object. It resolves one, at
 * the moment it needs it, through here.
 *
 * This module is a leaf on purpose. Every other module under `storage/sql`
 * imports `../database.svelte` for TYPES ONLY, because `database.svelte`
 * imports `globalApi.svelte`, which imports `sqlPersistenceRuntime` -- a value
 * import back into `database.svelte` from the SQL layer closes that cycle. A
 * publisher/resolver pair inverts the dependency: `database.svelte` calls in,
 * the SQL layer never calls out.
 */
let resolver: (() => Database | null | undefined) | null = null;

/**
 * Register how to reach the live database. `database.svelte` does this at module
 * load with `() => DBState.db`, so the binding tracks whatever is installed
 * there, including a wholesale replacement by a later `setDatabase`.
 */
export function publishLiveDatabase(resolve: (() => Database | null | undefined) | null): void {
  resolver = resolve;
}

/**
 * The live database, or `null` when there is not yet one to write.
 *
 * `DBState.db` starts life as `{}` and stays that way until `setDatabase`
 * installs the real graph, which happens after SQL storage has been activated.
 * Returning that placeholder would be worse than returning nothing: a commit
 * built from it reads every root key as `undefined`, and an undefined root key
 * that is not deferred becomes a DELETE. `characters` is the marker because
 * `setDatabase` guarantees it -- it is the first thing that function fills in --
 * so its presence means the graph has been installed and its absence means the
 * placeholder is still there.
 *
 * A commit that resolves `null` is skipped without acknowledging its dirty
 * scopes, so the marks survive to the next flush.
 */
export function resolveLiveDatabase(): Database | null {
  const database = resolver?.();
  if (!database || typeof database !== "object") return null;
  if (!Array.isArray((database as Database).characters)) return null;
  return database as Database;
}

/** Test-only: drop the registration so a suite cannot leak one into the next. */
export function resetLiveDatabaseForTesting(): void {
  resolver = null;
}
