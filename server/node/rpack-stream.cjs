'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { RPACK_DECODE_MAP } = require('./rpack-map.cjs');

class RPackStreamError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'RPackStreamError'; this.code = code; this.status = status; }
}

function invalid(message) { return new RPackStreamError('INVALID_IMPORT_INPUT', message, 400); }
function importLimit() { return new RPackStreamError('IMPORT_LIMIT_EXCEEDED', 'Import exceeds allowed size', 413); }
function importAborted() { return new RPackStreamError('IMPORT_ABORTED', 'Import aborted', 499); }

function validate(options) {
  if (!options || typeof options !== 'object') throw invalid('options are required');
  const { sourcePath, targetPath, start, length, chunkBytes = 64 * 1024, maxOutputBytes, onChunk, signal } = options;
  if (typeof sourcePath !== 'string' || !sourcePath || typeof targetPath !== 'string' || !targetPath) throw invalid('sourcePath and targetPath are required');
  if (!Number.isSafeInteger(start) || start < 0) throw invalid('start must be a non-negative safe integer');
  if (!Number.isSafeInteger(length) || length < 0) throw invalid('length must be a non-negative safe integer');
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) throw invalid('chunkBytes must be a safe integer from 1 through 1048576');
  if (!Number.isFinite(maxOutputBytes) || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) throw invalid('maxOutputBytes must be a finite non-negative safe integer');
  if (onChunk !== undefined && typeof onChunk !== 'function') throw invalid('onChunk must be a function');
  if (signal !== undefined && (!signal || typeof signal.addEventListener !== 'function')) throw invalid('signal must be an AbortSignal');
  if (start > Number.MAX_SAFE_INTEGER - length) throw invalid('source range overflows');
  if (length > maxOutputBytes) throw importLimit();
}

function checkAbort(signal) { if (signal && signal.aborted) throw importAborted(); }

function withAbort(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => { if (settled) return; settled = true; signal.removeEventListener('abort', onAbort); callback(value); };
    const onAbort = () => finish(reject, importAborted());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function readExact(handle, buffer, position, signal) {
  let offset = 0;
  while (offset < buffer.length) {
    checkAbort(signal);
    const result = await withAbort(handle.read(buffer, offset, buffer.length - offset, position + offset), signal);
    if (!Number.isSafeInteger(result.bytesRead) || result.bytesRead <= 0) throw invalid('Truncated RPack source');
    offset += result.bytesRead;
  }
}

async function writeAll(handle, buffer, signal) {
  let offset = 0;
  while (offset < buffer.length) {
    checkAbort(signal);
    const result = await withAbort(handle.write(buffer, offset, buffer.length - offset, null), signal);
    if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten <= 0) throw invalid('Unable to write decoded import');
    offset += result.bytesWritten;
  }
}

async function decodeRPackRangeToFile(options) {
  validate(options);
  const { sourcePath, targetPath, start, length, chunkBytes = 64 * 1024, maxOutputBytes, onChunk = () => {}, signal } = options;
  checkAbort(signal);
  let source; let target; let succeeded = false; let ownsTarget = false;
  try {
    const sourceStat = await fsp.stat(sourcePath);
    if (!sourceStat.isFile() || start + length > sourceStat.size) throw invalid('RPack source range is out of bounds');
    if (length > maxOutputBytes) throw importLimit();
    checkAbort(signal);
    source = await fsp.open(sourcePath, fs.constants.O_RDONLY);
    target = await fsp.open(targetPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    ownsTarget = true;
    await fsp.chmod(targetPath, 0o600);
    let remaining = length; let position = start; let bytes = 0;
    while (remaining) {
      checkAbort(signal);
      const size = Math.min(remaining, chunkBytes);
      const chunk = Buffer.allocUnsafe(size);
      await readExact(source, chunk, position, signal);
      for (let index = 0; index < chunk.length; index++) chunk[index] = RPACK_DECODE_MAP[chunk[index]];
      position += size; remaining -= size; bytes += size;
      onChunk({ bytes: size, totalBytes: bytes, remainingBytes: remaining, decodedChunk: chunk });
      await writeAll(target, chunk, signal);
    }
    checkAbort(signal);
    await withAbort(target.sync(), signal);
    await target.close(); target = undefined;
    await source.close(); source = undefined;
    succeeded = true;
    return { filePath: targetPath, bytes: length };
  } finally {
    if (target) { try { await target.close(); } catch {} }
    if (source) { try { await source.close(); } catch {} }
    if (!succeeded && ownsTarget) { try { await fsp.unlink(targetPath); } catch {} }
  }
}

module.exports = { RPackStreamError, importLimit, importAborted, decodeRPackRangeToFile };
