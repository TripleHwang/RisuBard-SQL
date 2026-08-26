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

function validate(sourcePath, targetPath, options) {
  if (typeof sourcePath !== 'string' || !sourcePath || typeof targetPath !== 'string' || !targetPath) throw invalid('sourcePath and targetPath are required');
  if (!options || !Number.isSafeInteger(options.start) || options.start < 0) throw invalid('start must be a non-negative safe integer');
  if (!Number.isSafeInteger(options.length) || options.length < 0) throw invalid('length must be a non-negative safe integer');
  if (!Number.isSafeInteger(options.chunkSize) || options.chunkSize <= 0) throw invalid('chunkSize must be a positive safe integer');
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 0) throw invalid('maxOutputBytes must be a non-negative safe integer');
  if (options.onChunk !== undefined && typeof options.onChunk !== 'function') throw invalid('onChunk must be a function');
  if (options.signal !== undefined && (!options.signal || typeof options.signal.addEventListener !== 'function')) throw invalid('signal must be an AbortSignal');
  if (options.start > Number.MAX_SAFE_INTEGER - options.length) throw invalid('source range overflows');
  if (options.length > options.maxOutputBytes) throw importLimit();
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

async function decodeRPackRangeToFile(sourcePath, targetPath, options) {
  validate(sourcePath, targetPath, options);
  const { start, length, chunkSize, maxOutputBytes, onChunk = () => {}, signal } = options;
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
      const size = Math.min(remaining, chunkSize);
      const chunk = Buffer.allocUnsafe(size);
      await readExact(source, chunk, position, signal);
      for (let index = 0; index < chunk.length; index++) chunk[index] = RPACK_DECODE_MAP[chunk[index]];
      await writeAll(target, chunk, signal);
      position += size; remaining -= size; bytes += size;
      onChunk({ bytes: size, totalBytes: bytes, remainingBytes: remaining });
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
