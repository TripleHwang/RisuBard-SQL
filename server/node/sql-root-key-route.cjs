'use strict';

const {
    normalizeSqlBootstrapQuery,
    normalizeSqlReadKey,
} = require('./sql-read-route-params.cjs');

/**
 * Bootstrap with optional root-key deferral.
 *
 * GET /api/sql/bootstrap
 * GET /api/sql/bootstrap?defer=plugins,pluginCustomStorage
 *
 * The response carries `deferredRootKeys` (present in storage, value withheld),
 * `absentDeferredRootKeys` (requested, but not in storage at all) and
 * `unreadableRootKeys` (registered but rebuilt to no value). Those three lists
 * exist so a client can never mistake "I did not load it" for "it is gone".
 */
function createSqlBootstrapHandler(options) {
    const auth = options.auth;
    const relationalSql = options.relationalSql;
    return async function sqlBootstrapHandler(req, res, next) {
        if (!await auth(req, res)) return;
        const parsed = normalizeSqlBootstrapQuery(req.query);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        try {
            const payload = relationalSql.bootstrap({ deferRootKeys: parsed.deferRootKeys });
            res.set('Cache-Control', 'no-store').json(payload);
        } catch (error) {
            next(error);
        }
    };
}

/**
 * Hydrate one deferred root key.
 *
 * GET /api/sql/root-keys/:rootKey
 *   200 { revision, key, present: true, value }   — stored, `value` may be null
 *   404 { error, key, present: false }            — not stored at all
 *   400 { error: 'Invalid key' }                  — out of bounds
 *
 * The `present` discriminator is deliberately in the body of both answers. A 404
 * without it is a routing or transport failure, and a client must never read one
 * as proof that the key was deleted.
 */
function createSqlRootKeyHandler(options) {
    const auth = options.auth;
    const relationalSql = options.relationalSql;
    return async function sqlRootKeyHandler(req, res, next) {
        if (!await auth(req, res)) return;
        const parsed = normalizeSqlReadKey(req.params.rootKey);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        try {
            const result = relationalSql.loadRootKey(parsed.key);
            res.set('Cache-Control', 'no-store');
            if (!result.present) {
                return res.status(404).json({
                    error: 'Root key not found',
                    key: parsed.key,
                    present: false,
                });
            }
            res.json(result);
        } catch (error) {
            next(error);
        }
    };
}

/**
 * Read one plugin storage row.
 *
 * GET /api/sql/plugin-storage/:key
 *   200 { revision, key, present: true, value }   — stored, `value` may be null
 *   404 { error, key, present: false }            — no such row
 *   400 { error: 'Invalid key' }                  — out of bounds
 *
 * The `present` discriminator is copied from the root-key route verbatim, and
 * for the same reason: a 404 is a statement about this row, and a client must
 * never be able to read a transport failure as "your plugin deleted this".
 *
 * This exists because `pluginCustomStorage` is the one deferred root key, and
 * hydrating it through `/api/sql/root-keys/pluginCustomStorage` returns the
 * entire map. A caller that wants one key was paying the whole store for it.
 */
function createSqlPluginStorageKeyHandler(options) {
    const auth = options.auth;
    const relationalSql = options.relationalSql;
    return async function sqlPluginStorageKeyHandler(req, res, next) {
        if (!await auth(req, res)) return;
        const parsed = normalizeSqlReadKey(req.params.storageKey);
        if (parsed.error) return res.status(400).json({ error: parsed.error });
        try {
            const result = relationalSql.loadPluginStorageKey(parsed.key);
            res.set('Cache-Control', 'no-store');
            if (!result.present) {
                return res.status(404).json({
                    error: 'Plugin storage key not found',
                    key: parsed.key,
                    present: false,
                });
            }
            res.json(result);
        } catch (error) {
            next(error);
        }
    };
}

/**
 * List every plugin storage key, without any value.
 *
 * GET /api/sql/plugin-storage  ->  200 { revision, keys: [...] }
 *
 * Unpaginated on purpose. `pluginStorage.keys()` and `length()` mean "this is
 * all of them"; a truncated list would be read as a complete one, and a plugin
 * acting on that re-initialises state it still has. The key column is small --
 * it is the values this route omits that are large.
 */
function createSqlPluginStorageKeyListHandler(options) {
    const auth = options.auth;
    const relationalSql = options.relationalSql;
    return async function sqlPluginStorageKeyListHandler(req, res, next) {
        if (!await auth(req, res)) return;
        try {
            res.set('Cache-Control', 'no-store').json(relationalSql.listPluginStorageKeys());
        } catch (error) {
            next(error);
        }
    };
}

module.exports = {
    createSqlBootstrapHandler,
    createSqlRootKeyHandler,
    createSqlPluginStorageKeyHandler,
    createSqlPluginStorageKeyListHandler,
};
