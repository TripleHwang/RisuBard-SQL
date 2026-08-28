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

module.exports = {
    createSqlBootstrapHandler,
    createSqlRootKeyHandler,
};
