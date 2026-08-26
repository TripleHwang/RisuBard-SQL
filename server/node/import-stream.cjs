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
function importLimit() { return new ImportStreamError('IMPORT_TOO_LARGE', 'Import exceeds allowed size', 413); }
function insufficientStorage() { return new ImportStreamError('INSUFFICIENT_STORAGE', 'Insufficient disk space', 507); }
function invalidInput(message) { return new ImportStreamError('INVALID_IMPORT_INPUT', message, 400); }

function normalizeError(error) {
  if (error instanceof ImportStreamError) return error;
  if (error && error.code === 'ENOSPC') return insufficientStorage();
  return invalidInput('Unable to read import input');
}

function checkOptions(source, options) {
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') throw invalidInput('source must be an async iterable');
  if (!options || typeof options.stagingRoot !== 'string' || !options.stagingRoot) throw invalidInput('stagingRoot is required');
  if (typeof options.prefix !== 'string' || !options.prefix || options.prefix.includes('/') || options.prefix.includes('\\') || options.prefix.includes('\0')) throw invalidInput('prefix is invalid');
  if (typeof options.filename !== 'string' || !options.filename || options.filename !== path.basename(options.filename) || options.filename.includes('\\') || options.filename.includes('\0')) throw invalidInput('filename is invalid');
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

async function spoolSourceToOwnedFile(source, options) {
  const { diskHeadroomBytes } = checkOptions(source, options);
  const { stagingRoot, prefix, filename, maxBytes, getAvailableBytes, signal } = options;
  if (signal && signal.aborted) throw importAborted();

  let ownedDir;
  let handle;
  let bytes = 0;
  let succeeded = false;
  try {
    await fsp.mkdir(stagingRoot, { recursive: true });
    ownedDir = await fsp.mkdtemp(path.join(stagingRoot, prefix));
    const filePath = path.join(ownedDir, filename);
    handle = await fsp.open(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    await fsp.chmod(filePath, 0o600);

    for await (const value of source) {
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
    if (handle) { try { await handle.close(); } catch {} }
    if (ownedDir && !succeeded) {
      // Successful calls return above; failures remove only this mkdtemp-owned directory.
      try { await fsp.rm(ownedDir, { recursive: true, force: true }); } catch {}
    }
  }
}

module.exports = { ImportStreamError, importAborted, importLimit, insufficientStorage, spoolSourceToOwnedFile };
