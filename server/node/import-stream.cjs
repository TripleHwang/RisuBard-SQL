'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

class ImportStreamError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'ImportStreamError';
    this.code = code;
    this.status = status;
  }
}

function importAborted() { return new ImportStreamError('IMPORT_ABORTED', 'Import aborted', 499); }
function importLimit() { return new ImportStreamError('IMPORT_LIMIT_EXCEEDED', 'Import exceeds allowed size', 413); }
function insufficientStorage() { return new ImportStreamError('INSUFFICIENT_STORAGE', 'Insufficient disk space', 507); }
function invalidInput(message) { return new ImportStreamError('INVALID_IMPORT_INPUT', message, 400); }

function normalizeError(error) {
  if (error instanceof ImportStreamError) return error;
  if (error && error.code === 'ENOSPC') return insufficientStorage();
  // Filesystem, capacity-probe, and source errors carry useful causes and
  // statuses; callers treat unclassified errors as server failures.
  return error || new ImportStreamError('IMPORT_STREAM_FAILED', 'Unable to spool import input', 500);
}

function checkOptions(source, options) {
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw invalidInput('source must be an async iterable');
  if (!options || typeof options.stagingRoot !== 'string' || !options.stagingRoot) throw invalidInput('stagingRoot is required');
  if (typeof options.prefix !== 'string' || !options.prefix || options.prefix.includes('/') || options.prefix.includes('\\') || options.prefix.includes('\0')) throw invalidInput('prefix is invalid');
  if (typeof options.filename !== 'string' || !options.filename || options.filename === '.' || options.filename === '..' || options.filename !== path.basename(options.filename) || options.filename.includes('\\') || options.filename.includes('\0')) throw invalidInput('filename is invalid');
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) throw invalidInput('maxBytes must be a non-negative safe integer');
  const diskHeadroomBytes = options.diskHeadroomBytes === undefined ? 0 : options.diskHeadroomBytes;
  if (!Number.isSafeInteger(diskHeadroomBytes) || diskHeadroomBytes < 0) throw invalidInput('diskHeadroomBytes must be a non-negative safe integer');
  if (options.getAvailableBytes !== undefined && typeof options.getAvailableBytes !== 'function') throw invalidInput('getAvailableBytes must be a function');
  return { diskHeadroomBytes };
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten <= 0) throw invalidInput('Unable to write import input');
    offset += bytesWritten;
  }
}

function closeIterator(iterator) {
  try {
    if (iterator && typeof iterator.return === 'function') Promise.resolve(iterator.return()).catch(() => {});
  } catch {}
}

function abortSource(iterator, source, error) {
  closeIterator(iterator);
  try {
    if (source && typeof source.destroy === 'function') source.destroy(error);
  } catch {}
}

function nextWithAbort(iterator, source, signal, closeForAbort) {
  if (!signal) return Promise.resolve().then(() => iterator.next());
  if (signal.aborted) {
    closeForAbort();
    return Promise.reject(importAborted());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = importAborted();
      closeForAbort(error);
      finish(reject, error);
    };
    signal.addEventListener('abort', onAbort);
    let next;
    try { next = iterator.next(); } catch (error) { finish(reject, error); return; }
    Promise.resolve(next).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function spoolSourceToOwnedFile(source, options) {
  const { diskHeadroomBytes } = checkOptions(source, options);
  const { stagingRoot, prefix, filename, maxBytes, getAvailableBytes, signal } = options;
  if (signal && signal.aborted) throw importAborted();

  let ownedDir;
  let handle;
  let bytes = 0;
  let succeeded = false;
  let iterator;
  let sourceAborted = false;
  const closeForAbort = (error = importAborted()) => {
    if (sourceAborted) return;
    sourceAborted = true;
    abortSource(iterator, source, error);
  };
  try {
    await fsp.mkdir(stagingRoot, { recursive: true });
    ownedDir = await fsp.mkdtemp(path.join(stagingRoot, prefix));
    const filePath = path.join(ownedDir, filename);
    handle = await fsp.open(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    await fsp.chmod(filePath, 0o600);

    iterator = source[Symbol.asyncIterator]();
    for (;;) {
      const next = await nextWithAbort(iterator, source, signal, closeForAbort);
      if (next.done) break;
      const value = next.value;
      if (signal && signal.aborted) throw importAborted();
      if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) throw invalidInput('source yielded a non-binary chunk');
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      if (chunk.length > maxBytes - bytes) throw importLimit();
      if (getAvailableBytes) {
        const available = getAvailableBytes({ phase: 'spool-write', needed: chunk.length, bytes });
        if (available && typeof available.then === 'function') throw invalidInput('getAvailableBytes must return synchronously');
        if (!Number.isFinite(available)) throw invalidInput('getAvailableBytes must return a finite number');
        if (available < chunk.length + diskHeadroomBytes) throw insufficientStorage();
      }
      await writeAll(handle, chunk);
      bytes += chunk.length;
    }
    if (signal && signal.aborted) throw importAborted();
    await handle.sync();
    await handle.close();
    handle = undefined;
    succeeded = true;
    return { ownedDir, filePath, bytes };
  } catch (error) {
    throw normalizeError(error);
  } finally {
    if (!succeeded && iterator && !sourceAborted) closeIterator(iterator);
    if (handle) { try { await handle.close(); } catch {} }
    if (ownedDir && !succeeded) {
      // Successful calls return above; failures remove only this mkdtemp-owned directory.
      try { await fsp.rm(ownedDir, { recursive: true, force: true }); } catch {}
    }
  }
}

module.exports = { ImportStreamError, importAborted, importLimit, insufficientStorage, spoolSourceToOwnedFile };
