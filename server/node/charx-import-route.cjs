'use strict';

const { DEFAULT_CHARX_LIMITS } = require('./charx-import.cjs');

function safeMessage(error) {
  switch (error && error.code) {
    case 'CHARX_LIMIT_EXCEEDED': return 'CharX archive exceeds the allowed limit';
    case 'INSUFFICIENT_STORAGE': return 'Insufficient disk space for CharX import';
    case 'IMPORT_ABORTED': return 'CharX import aborted';
    case 'INVALID_CHARX': return 'Invalid CharX archive';
    default: return 'Unable to import CharX archive';
  }
}

function createCharXImportHandler(deps) {
  const {
    checkAuth,
    checkActiveSession,
    beginImport,
    endImport,
    importCharXStream,
    publishAssets,
    stagingRoot,
    getAvailableBytes,
    limits = DEFAULT_CHARX_LIMITS,
    heartbeatMs = 5000,
    logger = console,
  } = deps;

  return async function charxImportHandler(req, res) {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;

    let acquired = false;
    let heartbeatTimer = null;
    let previousRequestTimeout;
    let previousSocketTimeout;
    let responseStarted = false;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onRequestClose = () => { if (!req.complete) abort(); };
    const onResponseClose = () => { if (!res.writableEnded) abort(); };
    const contentLength = Number(req.headers['content-length'] ?? '0');

    const writeJsonError = (status, code, message) => {
      if (!res.headersSent) res.status(status).json({ error: message, code });
    };
    const writeEvent = event => {
      if (!res.writableEnded) res.write(JSON.stringify(event) + '\n');
    };

    try {
      if (!beginImport()) {
        writeJsonError(409, 'IMPORT_IN_PROGRESS', 'Another import is already in progress');
        return;
      }
      acquired = true;

      const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/x-risu-charx') {
        writeJsonError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported CharX content-type');
        return;
      }
      if (Number.isFinite(contentLength) && contentLength > limits.compressedBytes) {
        writeJsonError(413, 'CHARX_LIMIT_EXCEEDED', 'CharX archive exceeds the allowed limit');
        return;
      }
      if (getAvailableBytes) {
        let available;
        try { available = getAvailableBytes({ phase: 'preflight', needed: Math.max(0, contentLength || 0) }); }
        catch (error) { throw error; }
        if (!Number.isFinite(available) || available < Math.max(0, contentLength || 0) + limits.diskHeadroomBytes) {
          writeJsonError(507, 'INSUFFICIENT_STORAGE', 'Insufficient disk space for CharX import');
          return;
        }
      }

      previousRequestTimeout = req.socket.server && req.socket.server.requestTimeout;
      previousSocketTimeout = req.socket.timeout;
      req.socket.setTimeout(0);
      req.socket.setKeepAlive(true);
      if (req.socket.server) req.socket.server.requestTimeout = 0;
      req.once('aborted', abort);
      req.once('close', onRequestClose);
      res.once('close', onResponseClose);

      res.status(200);
      res.setHeader('content-type', 'application/x-ndjson');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders();
      responseStarted = true;
      heartbeatTimer = setInterval(() => writeEvent({ type: 'heartbeat' }), Math.max(100, heartbeatMs));
      let lastProgressAt = 0;
      const result = await importCharXStream(req, {
        stagingRoot,
        publishAssets,
        limits,
        expectedCompressedBytes: Number.isFinite(contentLength) ? contentLength : 0,
        getAvailableBytes,
        signal: controller.signal,
        onProgress: progress => {
          const now = Date.now();
          if (now - lastProgressAt < 200) return;
          lastProgressAt = now;
          writeEvent({ type: 'progress', progress });
        },
      });
      writeEvent({ type: 'done', result });
      res.end();
    } catch (error) {
      const status = error && error.code === 'ENOSPC' ? 507 : (Number.isInteger(error && error.status) ? error.status : 500);
      const code = error && error.code === 'ENOSPC' ? 'INSUFFICIENT_STORAGE' : (error && error.code) || 'CHARX_IMPORT_FAILED';
      const message = safeMessage(error && error.code === 'ENOSPC' ? { code: 'INSUFFICIENT_STORAGE' } : error);
      if (responseStarted || res.headersSent) {
        writeEvent({ type: 'error', code, status, message });
        if (!res.writableEnded) res.end();
      } else {
        writeJsonError(status, code, message);
      }
      if (status >= 500 && code !== 'IMPORT_ABORTED') logger.warn?.('[CharX import] failed', code);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      req.removeListener('aborted', abort);
      req.removeListener('close', onRequestClose);
      res.removeListener('close', onResponseClose);
      if (req.socket) req.socket.setTimeout(previousSocketTimeout || 0);
      if (req.socket.server && previousRequestTimeout !== undefined) req.socket.server.requestTimeout = previousRequestTimeout;
      if (acquired) endImport();
    }
  };
}

module.exports = { createCharXImportHandler };
