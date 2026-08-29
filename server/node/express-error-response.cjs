'use strict';

/**
 * The terminal Express error handler.
 *
 * The one it replaces did two harmful things at once:
 *
 *     app.use((err, req, res, next) => {
 *         if (res.headersSent) return next(err);
 *         res.status(500).json({ error: err?.message || 'internal server error' });
 *     });
 *
 * It wrote nothing anywhere an operator would ever see, and it flattened every
 * error into 500 -- including errors that already carried a truthful status.
 * Express's own `PayloadTooLargeError` carries `status: 413`; a client that got
 * 500 back could not tell "your request was too big" from "the server broke",
 * and neither could anyone reading the logs, because there were none.
 *
 * Both halves are fixed here, and both are testable because this is a module
 * rather than a closure buried at the bottom of a 6,800-line file.
 */

/** Any Express-conventional status the error carries, else 500. */
function httpStatusForError(error) {
    const candidate = Number(
        error && typeof error === 'object'
            ? (error.status ?? error.statusCode)
            : undefined,
    );
    // A status outside the error range is not a status this handler can honour
    // -- a 200 or a 1e9 from a stray property must not become the response code.
    if (Number.isInteger(candidate) && candidate >= 400 && candidate <= 599) {
        return candidate;
    }
    return 500;
}

/**
 * `logError` receives one already-formatted line plus the stack, and defaults to
 * `console.error` so a standalone server's operator sees the failure in the
 * place they already look. It is injectable so tests can assert that failures
 * are reported rather than swallowed -- the point of the handler, not a detail.
 */
function createExpressErrorResponder(options) {
    const logError = options?.logError || console.error;
    return function respondWithError(err, req, res, next) {
        // Something already began writing this response; the only honest thing
        // left is to hand it back to Express, which will destroy the socket.
        if (res.headersSent) return next(err);
        const status = httpStatusForError(err);
        const message = (err && err.message) || 'internal server error';
        const method = (req && req.method) || '?';
        const target = (req && (req.originalUrl || req.url)) || '?';
        const code = err && typeof err === 'object' && typeof err.code === 'string'
            ? ` [${err.code}]`
            : '';
        try {
            logError(
                `[Express] ${method} ${target} -> ${status}${code}: ${message}`,
                (err && err.stack) || undefined,
            );
        } catch (loggingFailure) {
            // Reporting the failure must not replace the failure.
            console.error('[Express] error handler could not log:', loggingFailure);
        }
        res.status(status).json({ error: message });
    };
}

module.exports = {
    httpStatusForError,
    createExpressErrorResponder,
};
