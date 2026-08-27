// Computes which `assets/<hash>` KV keys are reachable ("uncleanable") from
// a database object, so an orphan sweep never deletes a still-referenced
// file. This module is the single source of truth for that computation and
// is required verbatim by BOTH runtimes that decide what to delete:
//
//   - client (Vite/TS, ESM): src/ts/globalApi.svelte.ts -> getUncleanables()
//     -> src/ts/bootstrap.ts -> cleanChunks()
//   - server (plain Node, CJS, no build step): server/node/server.cjs
//     -> buildUncleanableSet()
//
// History: character-scoped personas (`character.personas[].icon`, as
// opposed to global `db.personas[].icon`) were once collected on only one
// side, so their icons looked orphaned and got permanently deleted. Keeping
// the walk in one file (rather than two hand-synced copies) is what
// prevents that class of bug from coming back.
//
// SAFETY: this feeds a PERMANENT DELETE. When a reference is ambiguous,
// treat it as reachable (include it) rather than as an orphan -- a false
// "reachable" just wastes a few bytes of disk, a false "orphan" is
// unrecoverable user data loss.
//
// This file is intentionally framework-free (no imports) so both a
// Vite-bundled ESM client and a bare `node server.cjs` process can load it
// without a build step.

'use strict';

/**
 * True if `value` looks like it could be a stored `assets/<hash>` KV
 * reference -- i.e. it is a non-empty string that is not an external
 * http(s) URL and not an inline data: URL. Those two schemes are never KV
 * keys, so excluding them cannot turn a real reference into a false
 * "orphan"; it only stops them from adding meaningless noise to the
 * uncleanable set.
 *
 * @param {unknown} value
 * @returns {value is string}
 */
function isAssetKeyValue(value) {
    if (!value || typeof value !== 'string') return false;
    if (/^https?:\/\//i.test(value)) return false;
    if (/^data:/i.test(value)) return false;
    return true;
}

/**
 * Walks one persona array (either `db.personas` -- global personas -- or a
 * `character.personas` -- character-scoped personas) and reports every
 * asset reference it owns via `add`: the persona icon, plus its embedded
 * module's icon/assets when present. Both persona arrays share the exact
 * same shape, so this is the one place that shape is walked.
 *
 * @param {readonly any[] | undefined | null} personas
 * @param {(value: unknown) => void} add
 * @param {{ includeModuleAssets?: boolean }} [opts]
 */
function collectPersonaAssetRefs(personas, add, opts) {
    if (!Array.isArray(personas)) return;
    const includeModuleAssets = !opts || opts.includeModuleAssets !== false;
    for (const persona of personas) {
        if (!persona) continue;
        add(persona.icon);
        const embedded = persona.embeddedModule;
        if (!embedded) continue;
        if (includeModuleAssets && Array.isArray(embedded.assets)) {
            for (const asset of embedded.assets) add(asset && asset[1]);
        }
        add(embedded.icon);
    }
}

module.exports = { isAssetKeyValue, collectPersonaAssetRefs };
