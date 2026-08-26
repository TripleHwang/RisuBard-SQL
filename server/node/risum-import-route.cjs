'use strict';

const fsp = require('node:fs/promises');
const { spoolSourceToOwnedFile } = require('./import-stream.cjs');
const { importRisumFile, DEFAULT_RISUM_LIMITS } = require('./risum-import.cjs');

// requestTimeout is held on the Server rather than an individual request. Keep
// its suspension narrow and reference-counted so a concurrent large upload
// cannot restore a timeout while another still needs it disabled.
const requestTimeoutOverrides = new WeakMap();
function suspendRequestTimeout(req) {
  const server = req.socket && req.socket.server;
  if (!server || typeof server.requestTimeout !== 'number' || server.requestTimeout === 0) return () => {};
  let override = requestTimeoutOverrides.get(server);
  if (!override) { override = { original: server.requestTimeout, count: 0 }; requestTimeoutOverrides.set(server, override); server.requestTimeout = 0; }
  override.count++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--override.count !== 0) return;
    requestTimeoutOverrides.delete(server);
    if (server.requestTimeout === 0) server.requestTimeout = override.original;
  };
}

function parseContentLength(value) {
  if (value === undefined) return null;
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isSafeInteger(number) ? number : undefined;
}
function safeMessage(error) {
  switch (error && error.code) {
    case 'IMPORT_LIMIT_EXCEEDED': return 'Risum archive exceeds the allowed limit';
    case 'INSUFFICIENT_STORAGE': return 'Insufficient disk space for risum import';
    case 'IMPORT_ABORTED': return 'Risum import aborted';
    case 'INVALID_RISUM': return 'Invalid risum archive';
    default: return 'Unable to import risum archive';
  }
}
function statusFor(error) {
  if (error && error.code === 'ENOSPC') return 507;
  return Number.isInteger(error && error.status) ? error.status : 500;
}

function createRisumImportHandler(deps) {
  const {
    checkAuth, checkActiveSession, beginImport, endImport, publishAssets, stagingRoot,
    getAvailableBytes, limits = DEFAULT_RISUM_LIMITS, heartbeatMs = 5000, logger = console,
    spoolSourceToOwnedFile: spool = spoolSourceToOwnedFile,
    importRisumFile: importFile = importRisumFile,
    removeOwnedDir = dir => fsp.rm(dir, { recursive: true, force: true }),
  } = deps;
  return async function risumImportHandler(req, res) {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    let acquired = false; let responseStarted = false; let heartbeatTimer = null;
    let priorSocketTimeout; let restoreRequestTimeout = () => {}; let staged;
    const controller = new AbortController();
    const abort = () => controller.abort();
    const onRequestClose = () => { if (req.aborted || !req.complete) abort(); };
    const onResponseClose = () => { if (!res.writableEnded) abort(); };
    const contentLength = parseContentLength(req.headers['content-length']);
    const writeJsonError = (status, code, message) => { if (!res.headersSent) res.status(status).json({ error: message, code }); };
    const writeEvent = event => { if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(event) + '\n'); };
    try {
      if (!beginImport()) { writeJsonError(409, 'IMPORT_IN_PROGRESS', 'Another import is already in progress'); return; }
      acquired = true;
      const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/x-risu-module') { writeJsonError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported risum content-type'); return; }
      if (contentLength === undefined) { writeJsonError(400, 'INVALID_CONTENT_LENGTH', 'Invalid content length'); return; }
      if (contentLength !== null && contentLength > limits.compressedBytes) { writeJsonError(413, 'IMPORT_LIMIT_EXCEEDED', 'Risum archive exceeds the allowed limit'); return; }
      const knownBytes = contentLength || 0;
      if (getAvailableBytes) {
        const available = getAvailableBytes({ phase: 'preflight', needed: knownBytes });
        if (!Number.isFinite(available) || available < knownBytes + limits.diskHeadroomBytes) { writeJsonError(507, 'INSUFFICIENT_STORAGE', 'Insufficient disk space for risum import'); return; }
      }
      priorSocketTimeout = req.socket && req.socket.timeout;
      req.socket?.setTimeout(0); req.socket?.setKeepAlive(true);
      restoreRequestTimeout = suspendRequestTimeout(req);
      req.once('aborted', abort); req.once('close', onRequestClose); req.once('end', restoreRequestTimeout); res.once('close', onResponseClose);
      res.status(200); res.setHeader('content-type', 'application/x-ndjson'); res.setHeader('cache-control', 'no-cache, no-transform'); res.setHeader('x-accel-buffering', 'no'); res.flushHeaders(); responseStarted = true;
      heartbeatTimer = setInterval(() => writeEvent({ type: 'heartbeat' }), Math.max(100, heartbeatMs));
      let lastAt = 0; let lastCompleted = 0; let lastTotal = knownBytes; let lastPhase = '';
      const progress = (phase, completed, total, terminal = false) => {
        const now = Date.now();
        if (phase !== lastPhase) { lastPhase = phase; lastAt = 0; lastCompleted = 0; lastTotal = 0; }
        lastCompleted = Math.max(lastCompleted, Number.isFinite(completed) ? Math.max(0, completed) : 0);
        lastTotal = Math.max(lastTotal, Number.isFinite(total) ? Math.max(0, total) : 0, lastCompleted);
        if (!terminal && now - lastAt < 200) return;
        lastAt = now; writeEvent({ type: 'progress', phase, completed: lastCompleted, total: lastTotal });
      };
      let received = 0;
      const source = (async function* () {
        for await (const chunk of req) {
          if (controller.signal.aborted) break;
          received += chunk.length; progress('upload', received, knownBytes || received);
          yield chunk;
        }
      })();
      // Keep the request available to transport adapters without changing the
      // streamed iterator contract.
      source.socket = req.socket;
      staged = await spool(source, {
        stagingRoot, prefix: 'risum-upload-', filename: 'archive.risum', maxBytes: limits.compressedBytes,
        diskHeadroomBytes: limits.diskHeadroomBytes, getAvailableBytes, signal: controller.signal,
      });
      progress('upload', staged.bytes, knownBytes || staged.bytes, true);
      const result = await importFile({ archivePath: staged.filePath, stagingRoot, publishAssets, limits, signal: controller.signal, getAvailableBytes,
        onProgress: update => progress(update && update.phase || 'validate', Number(update && update.completed), Number(update && update.total), update && update.terminal === true),
      });
      writeEvent({ type: 'done', result }); res.end();
    } catch (error) {
      const status = statusFor(error); const code = error && error.code === 'ENOSPC' ? 'INSUFFICIENT_STORAGE' : (error && error.code) || 'RISUM_IMPORT_FAILED'; const message = safeMessage(error && error.code === 'ENOSPC' ? { code: 'INSUFFICIENT_STORAGE' } : error);
      if (responseStarted || res.headersSent) { writeEvent({ type: 'error', code, status, message }); if (!res.writableEnded) res.end(); }
      else writeJsonError(status, code, message);
      if (status >= 500 && code !== 'IMPORT_ABORTED') logger.warn?.('[Risum import] failed', code);
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      req.removeListener('aborted', abort); req.removeListener('close', onRequestClose); req.removeListener('end', restoreRequestTimeout); res.removeListener('close', onResponseClose);
      restoreRequestTimeout();
      if (req.socket && priorSocketTimeout !== undefined) req.socket.setTimeout(priorSocketTimeout);
      if (staged && staged.ownedDir) { try { await removeOwnedDir(staged.ownedDir); } catch {} }
      if (acquired) endImport();
    }
  };
}

module.exports = { createRisumImportHandler };
