// The single source of truth for which `system_settings` root keys are
// EXCLUDED from the fast `/api/sql/bootstrap` payload and only arrive later
// via `/api/sql/deferred-bootstrap`. This file is required verbatim by BOTH
// runtimes that have to agree on that list:
//
//   - server (plain Node, CJS, no build step): server/node/relational-sqlite.cjs
//     -> DEFERRED_BOOTSTRAP_KEYS (bootstrap() filter + deferredBootstrap())
//   - client (Vite/TS, ESM): src/ts/storage/sql/rootWritePolicy.ts
//     -> DEFERRED_ROOT_KEYS (refuses to write a deferred key before hydration)
//
// History: `plugins` is on this list, so `db.plugins` is legitimately
// `undefined` from first paint until `hydrateDeferredDatabase()` lands. The
// dirty-commit builder used to translate "root key is undefined" into
// `DELETE FROM system_settings WHERE key='plugins'`, and
// `setting_extension_nodes.setting_key ... ON DELETE CASCADE` then destroyed
// every plugin row permanently. The client guard that prevents that has to
// know EXACTLY which keys the server withholds -- a hand-copied literal that
// drifts by one key is the same unrecoverable bug again, for that key.
//
// SAFETY: this feeds a WRITE GUARD in front of a cascading DELETE. When in
// doubt, ADD a key here: a false "deferred" only postpones one write until
// hydration completes, a false "not deferred" is unrecoverable user data loss.
//
// This file is intentionally framework-free (no imports) so both a
// Vite-bundled ESM client and a bare `node server.cjs` process can load it
// without a build step.

'use strict';

/**
 * Root `system_settings` keys withheld from the fast bootstrap payload.
 * Ordered for readability only; consumers treat this as a set.
 *
 * @type {readonly string[]}
 */
const DEFERRED_BOOTSTRAP_KEY_LIST = Object.freeze([
    'plugins',
    'pluginV2',
    'personas',
    'loreBook',
    'modules',
    'globalscript',
    'customScripts',
    'scripts',
    'promptCollections',
    'prompts',
    'loadouts',
    'translatorPresets',
]);

/** @type {ReadonlySet<string>} */
const DEFERRED_BOOTSTRAP_KEYS = new Set(DEFERRED_BOOTSTRAP_KEY_LIST);

/**
 * @param {unknown} key
 * @returns {boolean}
 */
function isDeferredBootstrapKey(key) {
    return typeof key === 'string' && DEFERRED_BOOTSTRAP_KEYS.has(key);
}

module.exports = {
    DEFERRED_BOOTSTRAP_KEY_LIST,
    DEFERRED_BOOTSTRAP_KEYS,
    isDeferredBootstrapKey,
};
