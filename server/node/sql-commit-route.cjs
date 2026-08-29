'use strict';

/**
 * POST /api/sql/commit
 *
 * One commit, or one chunk of a migration that is too big to be one commit.
 * The body is the shape `relationalSql.commit()` accepts:
 *
 *     { baseRevision, action, statements: [{ sql, bind }], migration? }
 *     migration = { id, chunk, final, totalChunks? }
 *
 * Every conflicting answer is a 409 carrying the state the client needs to
 * recover with -- the revision it should have used, and, for a migration, the
 * chunk the server will actually accept next. None of them is a bare failure
 * the client has to guess at, which is the whole reason the previous version of
 * this route's failure mode went unnoticed for months.
 */
const SQL_COMMIT_CONFLICT_CODES = new Set([
    'SQL_REVISION_CONFLICT',
    'SQL_MIGRATION_IN_PROGRESS',
    'SQL_MIGRATION_NOT_FOUND',
    'SQL_MIGRATION_MISMATCH',
    'SQL_MIGRATION_SEQUENCE',
]);

function createSqlCommitHandler(options) {
    const auth = options.auth;
    const activeSession = options.activeSession;
    const relationalSql = options.relationalSql;
    const queue = options.queue || ((operation) => operation());
    return async function sqlCommitHandler(req, res, next) {
        if (!await auth(req, res)) return;
        if (!activeSession(req, res)) return;
        try {
            const result = await queue(async () => relationalSql.commit(req.body));
            res.json(result);
        } catch (error) {
            if (error && SQL_COMMIT_CONFLICT_CODES.has(error.code)) {
                const body = { error: error.message, code: error.code };
                // Present-but-null is a real answer here: `migration: null` says
                // no sequence is in flight, which is different from a payload
                // that simply does not mention migrations.
                if ('currentRevision' in error) body.currentRevision = error.currentRevision;
                if ('expectedChunk' in error) body.expectedChunk = error.expectedChunk;
                if ('migration' in error) body.migration = error.migration;
                return res.status(409).json(body);
            }
            // Everything else -- including the 413 a too-large commit carries --
            // goes to the terminal error handler, which logs it and honours the
            // status the error came with.
            next(error);
        }
    };
}

module.exports = {
    SQL_COMMIT_CONFLICT_CODES,
    createSqlCommitHandler,
};
