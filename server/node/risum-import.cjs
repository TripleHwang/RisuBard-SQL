'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { decodeRPackRangeToFile } = require('./rpack-stream.cjs');

const DEFAULT_RISUM_LIMITS = Object.freeze({
  compressedBytes: 4 * 1024 ** 3,
  metadataBytes: 64 * 1024 ** 2,
  entries: 100000,
  assetDecodedBytes: 256 * 1024 ** 2,
  decodedBytes: 32 * 1024 ** 3,
  diskHeadroomBytes: 512 * 1024 ** 2,
  ioChunkBytes: 64 * 1024,
});

class RisumImportError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'RisumImportError'; this.code = code; this.status = status; }
}
function invalid(message) { return new RisumImportError('INVALID_RISUM', message); }
function limit(message) { return new RisumImportError('IMPORT_LIMIT_EXCEEDED', message, 413); }
function noSpace() { return new RisumImportError('INSUFFICIENT_STORAGE', 'Insufficient disk space for risum import', 507); }
function aborted() { return new RisumImportError('IMPORT_ABORTED', 'Risum import aborted', 499); }

function checkAbort(signal) { if (signal && signal.aborted) throw aborted(); }
function safeAdd(left, right) { if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0 || left > Number.MAX_SAFE_INTEGER - right) throw invalid('Invalid risum length'); return left + right; }
function checkSpace(getAvailableBytes, limits, phase, needed) {
  if (!getAvailableBytes) return;
  const available = getAvailableBytes({ phase, needed });
  if (available && typeof available.then === 'function') throw new TypeError('getAvailableBytes must return synchronously');
  if (!Number.isFinite(available) || available < needed + limits.diskHeadroomBytes) throw noSpace();
}
function normalize(error) {
  if (error instanceof RisumImportError) return error;
  if (error && error.code === 'IMPORT_ABORTED') return aborted();
  if (error && error.code === 'IMPORT_LIMIT_EXCEEDED') return limit(error.message);
  if (error && error.code === 'INVALID_IMPORT_INPUT') return invalid(error.message);
  if (error && error.code === 'ENOSPC') return noSpace();
  return error || invalid('Unable to import risum');
}

async function readExactly(handle, position, length, archiveSize, signal) {
  if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || safeAdd(position, length) > archiveSize) throw invalid('Truncated risum archive');
  const out = Buffer.allocUnsafe(length); let offset = 0;
  while (offset < length) {
    checkAbort(signal);
    const { bytesRead } = await handle.read(out, offset, length - offset, position + offset);
    if (!Number.isSafeInteger(bytesRead) || bytesRead <= 0) throw invalid('Truncated risum archive');
    offset += bytesRead;
  }
  return out;
}
function uint32(bytes) { return bytes.readUInt32LE(0); }
function strictJson(value) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { throw invalid('Metadata is not valid UTF-8'); }
  try { return JSON.parse(text); } catch { throw invalid('Metadata is not valid JSON'); }
}
function validModule(main) {
  if (!main || typeof main !== 'object' || Array.isArray(main) || main.type !== 'risuModule' || !main.module || typeof main.module !== 'object' || Array.isArray(main.module)) throw invalid('Invalid risum module metadata');
  if (!Array.isArray(main.module.assets) || main.module.assets.some(asset => !Array.isArray(asset) || asset.length < 2)) throw invalid('Invalid risum asset metadata');
  return main.module;
}

async function importRisumFile({ archivePath, stagingRoot, publishAssets, limits: suppliedLimits, signal, getAvailableBytes, onProgress = () => {} }) {
  const limits = { ...DEFAULT_RISUM_LIMITS, ...(suppliedLimits || {}) };
  if (typeof archivePath !== 'string' || !archivePath || typeof stagingRoot !== 'string' || !stagingRoot || typeof publishAssets !== 'function') throw new TypeError('archivePath, stagingRoot, and publishAssets are required');
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid risum limits');
  if (limits.ioChunkBytes < 1 || limits.ioChunkBytes > 1024 * 1024) throw new TypeError('Invalid risum I/O chunk size');
  let archive; let ownedDir;
  try {
    checkAbort(signal);
    const stat = await fsp.stat(archivePath);
    if (!stat.isFile()) throw invalid('Risum archive is not a file');
    if (stat.size > limits.compressedBytes) throw limit('Risum archive exceeds compressed limit');
    checkSpace(getAvailableBytes, limits, 'preflight', stat.size);
    await fsp.mkdir(stagingRoot, { recursive: true }); ownedDir = await fsp.mkdtemp(path.join(stagingRoot, 'risum-'));
    archive = await fsp.open(archivePath, fs.constants.O_RDONLY);
    const header = await readExactly(archive, 0, 6, stat.size, signal);
    if (header[0] !== 111 || header[1] !== 0) throw invalid('Unsupported risum format');
    const metadataLength = uint32(header.subarray(2));
    if (metadataLength > limits.metadataBytes) throw limit('Risum metadata exceeds limit');
    let position = 6; const metadataEnd = safeAdd(position, metadataLength); if (metadataEnd > stat.size) throw invalid('Truncated risum metadata');
    let decodedBytes = 0; let metadataDecoded = 0;
    const metadataPath = path.join(ownedDir, 'metadata.json'); checkSpace(getAvailableBytes, limits, 'metadata', metadataLength);
    await decodeRPackRangeToFile({ sourcePath: archivePath, start: position, length: metadataLength, targetPath: metadataPath, chunkBytes: limits.ioChunkBytes, maxOutputBytes: limits.metadataBytes, signal, onChunk: ({ bytes }) => {
      checkAbort(signal); metadataDecoded = safeAdd(metadataDecoded, bytes); if (metadataDecoded > limits.metadataBytes) throw limit('Risum metadata exceeds limit');
      decodedBytes = safeAdd(decodedBytes, bytes); if (decodedBytes > limits.decodedBytes) throw limit('Risum decoded data exceeds limit');
      checkSpace(getAvailableBytes, limits, 'metadata-chunk', bytes);
    } });
    position = metadataEnd;
    const module = validModule(strictJson(await fsp.readFile(metadataPath)));
    let records = 0; let completed = 0; const entries = []; const keys = new Set(); const assetKeys = [];
    onProgress({ phase: 'validate', completed, total: module.assets.length });
    for (;;) {
      checkAbort(signal);
      const mark = await readExactly(archive, position, 1, stat.size, signal); position = safeAdd(position, 1);
      if (mark[0] === 0) break;
      if (mark[0] !== 1) throw invalid('Invalid risum asset marker');
      if (++records > limits.entries) throw limit('Risum has too many assets');
      const length = uint32(await readExactly(archive, position, 4, stat.size, signal)); position = safeAdd(position, 4);
      const nextPosition = safeAdd(position, length); if (nextPosition > stat.size) throw invalid('Truncated risum asset');
      if (length > limits.assetDecodedBytes) throw limit('Risum asset exceeds limit');
      if (safeAdd(decodedBytes, length) > limits.decodedBytes) throw limit('Risum decoded data exceeds limit');
      checkSpace(getAvailableBytes, limits, 'asset', length);
      const targetPath = path.join(ownedDir, `asset-${records}.decoded`); const hash = createHash('sha256'); let assetDecoded = 0;
      await decodeRPackRangeToFile({ sourcePath: archivePath, start: position, length, targetPath, chunkBytes: limits.ioChunkBytes, maxOutputBytes: limits.assetDecodedBytes, signal, onChunk: ({ bytes, decodedChunk }) => {
        checkAbort(signal); assetDecoded = safeAdd(assetDecoded, bytes); if (assetDecoded > limits.assetDecodedBytes) throw limit('Risum asset exceeds limit');
        decodedBytes = safeAdd(decodedBytes, bytes); if (decodedBytes > limits.decodedBytes) throw limit('Risum decoded data exceeds limit');
        checkSpace(getAvailableBytes, limits, 'asset-chunk', bytes); hash.update(decodedChunk);
      } });
      const key = `assets/${hash.digest('hex')}.png`; assetKeys.push(key); if (!keys.has(key)) { keys.add(key); entries.push({ key, sourcePath: targetPath }); }
      position = nextPosition; completed += 1; onProgress({ phase: 'assets', completed, total: module.assets.length });
    }
    if (position !== stat.size) throw invalid('Unexpected trailing risum data');
    if (records !== module.assets.length) throw invalid('Risum asset record count does not match metadata');
    for (let index = 0; index < module.assets.length; index++) module.assets[index][1] = assetKeys[index];
    checkAbort(signal); onProgress({ phase: 'publish', completed, total: module.assets.length }); await publishAssets(entries); checkAbort(signal);
    return { module, assets: records, decodedBytes };
  } catch (error) { throw normalize(error); }
  finally {
    if (archive) { try { await archive.close(); } catch {} }
    if (ownedDir) { try { await fsp.rm(ownedDir, { recursive: true, force: true }); } catch {} }
  }
}

module.exports = { DEFAULT_RISUM_LIMITS, RisumImportError, importRisumFile };
