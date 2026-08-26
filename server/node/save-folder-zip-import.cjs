'use strict';

// The archive is deliberately read from an already-spooled file.  fflate's
// streaming Unzip API keeps compressed and decoded data bounded to a 64 KiB
// read buffer; the central directory is validated before any staged file can
// be published.
const { Unzip, UnzipInflate } = require('fflate');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const DEFAULT_SAVE_FOLDER_ZIP_LIMITS = Object.freeze({
  compressedBytes: 4 * 1024 ** 3, entries: 100_000,
  entryBytes: 256 * 1024 ** 2, decompressedBytes: 32 * 1024 ** 3,
  maxExpansionRatio: 200, diskHeadroomBytes: 512 * 1024 ** 2,
  chunkBytes: 64 * 1024,
});
class SaveFolderZipImportError extends Error {
  constructor(code, message, status = 400) { super(message); this.name = 'SaveFolderZipImportError'; this.code = code; this.status = status; }
}
const invalid = message => new SaveFolderZipImportError('INVALID_SAVE_FOLDER_ZIP', message);
const limited = message => new SaveFolderZipImportError('SAVE_FOLDER_ZIP_LIMIT_EXCEEDED', message, 413);
const noSpace = () => new SaveFolderZipImportError('INSUFFICIENT_STORAGE', 'Insufficient disk space for save-folder import', 507);
const aborted = () => new SaveFolderZipImportError('IMPORT_ABORTED', 'Save-folder import aborted', 499);
const u16 = (b, n) => b[n] | b[n + 1] << 8;
const u32 = (b, n) => b[n] + b[n + 1] * 0x100 + b[n + 2] * 0x10000 + b[n + 3] * 0x1000000;
function readExact(fd, at, length) { const b = Buffer.allocUnsafe(length); if (fs.readSync(fd, b, 0, length, at) !== length) throw invalid('Truncated ZIP archive'); return b; }
function nameOf(bytes) { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('ZIP names must be valid UTF-8'); } }
function safeArchiveName(name, seen) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) throw invalid('Unsafe ZIP entry name');
  const nfc = name.normalize('NFC'); if (seen.has(nfc)) throw invalid('Duplicate ZIP entry name'); seen.add(nfc);
  const parts = (name.endsWith('/') ? name.slice(0, -1) : name).split('/');
  if (!parts.length || parts.some(x => !x || x === '.' || x === '..')) throw invalid('Unsafe ZIP entry name');
  return name;
}
function decodeKey(name, keys) {
  const basename = name.slice(name.lastIndexOf('/') + 1);
  if (!/^(?:[a-fA-F0-9]{2})+$/.test(basename)) throw invalid('Save-folder entry filename must be hexadecimal');
  let key; try { key = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(basename, 'hex')); } catch { throw invalid('Invalid hexadecimal save-folder key'); }
  if (!key || key.includes('\0') || key.includes('\\') || key.startsWith('/') || /^[a-zA-Z]:/.test(key) || key.split('/').some(x => !x || x === '.' || x === '..')) throw invalid('Unsafe decoded save-folder key');
  if (keys.has(key)) throw invalid('Duplicate decoded save-folder key'); keys.add(key); return key;
}
function findEocd(fd, size) {
  const length = Math.min(size, 65557), tail = readExact(fd, size - length, length);
  for (let i = length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50 && i + 22 + u16(tail, i + 20) === length) return size - length + i;
  throw invalid('Truncated or invalid ZIP archive');
}
function centralEntries(fd, size, limits) {
  const eocdAt = findEocd(fd, size), eocd = readExact(fd, eocdAt, 22);
  const count = u16(eocd, 10), centralSize = u32(eocd, 12), declaredOffset = u32(eocd, 16), actualOffset = eocdAt - centralSize, bias = actualOffset - declaredOffset;
  if (u16(eocd, 4) || u16(eocd, 6) || u16(eocd, 8) !== count || count === 0xffff || centralSize === 0xffffffff || declaredOffset === 0xffffffff || actualOffset < 0 || bias < 0 || actualOffset + centralSize !== eocdAt) throw invalid('ZIP64, multidisk, or invalid ZIP directory is unsupported');
  if (count > limits.entries) throw limited('Archive has too many entries');
  const names = new Set(), keys = new Set(), entries = []; let at = actualOffset, total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > eocdAt) throw invalid('Truncated ZIP central directory'); const h = readExact(fd, at, 46);
    if (u32(h, 0) !== 0x02014b50) throw invalid('Invalid ZIP central directory');
    const flags = u16(h, 8), method = u16(h, 10), crc = u32(h, 16), compressedSize = u32(h, 20), sizeOut = u32(h, 24), nl = u16(h, 28), xl = u16(h, 30), cl = u16(h, 32), disk = u16(h, 34), external = u32(h, 38), declaredLocal = u32(h, 42), end = at + 46 + nl + xl + cl;
    if ((flags & 1) || (flags & 0x40) || (method !== 0 && method !== 8) || disk || compressedSize === 0xffffffff || sizeOut === 0xffffffff || declaredLocal === 0xffffffff || end > eocdAt || ((external >>> 16) & 0xf000) === 0xa000) throw invalid('Encrypted, symlink, ZIP64, or unsupported ZIP entry');
    const name = safeArchiveName(nameOf(readExact(fd, at + 46, nl)), names);
    if (name.endsWith('/')) { if (compressedSize || sizeOut) throw invalid('Directory entries must be empty'); at = end; continue; }
    const key = decodeKey(name, keys); if (sizeOut > limits.entryBytes) throw limited('Save-folder entry exceeds size limit');
    total += sizeOut; if (total > limits.decompressedBytes || (compressedSize && sizeOut / compressedSize > limits.maxExpansionRatio) || (!compressedSize && sizeOut)) throw limited('Archive exceeds decompression limits');
    const localOffset = declaredLocal + bias; if (!Number.isSafeInteger(localOffset) || localOffset < 0 || localOffset >= actualOffset) throw invalid('Invalid ZIP local offset');
    const local = readExact(fd, localOffset, 30); if (u32(local, 0) !== 0x04034b50 || u16(local, 6) !== flags || u16(local, 8) !== method) throw invalid('ZIP local header mismatch');
    const lnl = u16(local, 26), lxl = u16(local, 28), dataAt = localOffset + 30 + lnl + lxl, dataEnd = dataAt + compressedSize;
    if (dataEnd > actualOffset || nameOf(readExact(fd, localOffset + 30, lnl)) !== name) throw invalid('ZIP local header mismatch');
    if (flags & 8) {
      if (dataEnd + 12 > actualOffset) throw invalid('Truncated ZIP data descriptor');
      const first = readExact(fd, dataEnd, 4), signed = u32(first, 0) === 0x08074b50, descriptor = signed ? readExact(fd, dataEnd + 4, 12) : Buffer.concat([first, readExact(fd, dataEnd + 4, 8)]);
      if ((signed && dataEnd + 16 > actualOffset) || u32(descriptor, signed ? 0 : 0) !== crc || u32(descriptor, signed ? 4 : 4) !== compressedSize || u32(descriptor, signed ? 8 : 8) !== sizeOut) throw invalid('Invalid ZIP data descriptor');
    }
    entries.push({ name, key, flags, method, crc, compressedSize, originalSize: sizeOut, localOffset, headerLength: 30 + lnl + lxl, dataAt }); at = end;
  }
  if (at !== actualOffset + centralSize) throw invalid('Invalid ZIP central directory');
  if (!keys.has('database/database.bin')) throw invalid('Archive must contain database/database.bin');
  return { entries, total };
}
const CRC = (() => { const a = new Uint32Array(256); for (let i = 0; i < 256; i++) { let v = i; for (let n = 0; n < 8; n++) v = (v >>> 1) ^ (0xedb88320 & -(v & 1)); a[i] = v >>> 0; } return a; })();
const crcUpdate = (c, bytes) => { for (const b of bytes) c = (CRC[(c ^ b) & 255] ^ (c >>> 8)) >>> 0; return c; };

async function importSaveFolderZip(options) {
  const { archivePath, stagingRoot, replaceAllFromFiles, signal, getAvailableBytes, onProgress = () => {} } = options || {};
  const limits = { ...DEFAULT_SAVE_FOLDER_ZIP_LIMITS, ...(options && options.limits) };
  if (typeof archivePath !== 'string' || !stagingRoot || typeof replaceAllFromFiles !== 'function') throw new TypeError('archivePath, stagingRoot, and replaceAllFromFiles are required');
  const checkAbort = () => { if (signal?.aborted) throw aborted(); };
  const checkSpace = (phase, needed) => { if (!getAvailableBytes) return; const n = getAvailableBytes({ phase, needed }); if (!Number.isFinite(n) || n < needed + limits.diskHeadroomBytes) throw noSpace(); };
  let ownedDir; let fd; const active = new Set(); let failure;
  try {
    checkAbort(); const stat = await fsp.stat(archivePath); if (!stat.isFile() || stat.size > limits.compressedBytes) throw limited('Compressed save-folder ZIP exceeds size limit');
    fd = fs.openSync(archivePath, 'r'); const { entries, total } = centralEntries(fd, stat.size, limits); await fsp.mkdir(stagingRoot, { recursive: true }); ownedDir = await fsp.mkdtemp(path.join(stagingRoot, 'save-folder-'));
    const files = new Map(), unzip = new Unzip(file => {
      try {
        const entry = active.current; if (!entry || file.name !== entry.name) throw invalid('ZIP extraction metadata mismatch');
        const state = { entry, size: 0, crc: 0xffffffff, filePath: path.join(ownedDir, randomBytes(16).toString('hex')), out: undefined }; state.out = fs.openSync(state.filePath, 'wx', 0o600); active.add(state);
        file.ondata = (error, bytes, final) => { try { if (error) throw invalid('Corrupt ZIP entry'); checkAbort(); state.size += bytes.length; if (state.size > entry.originalSize || state.size > limits.entryBytes) throw limited('Save-folder entry exceeds size limit'); checkSpace('extract-write', bytes.length); fs.writeSync(state.out, bytes); state.crc = crcUpdate(state.crc, bytes); if (final) { fs.fsyncSync(state.out); fs.closeSync(state.out); state.out = undefined; if (state.size !== entry.originalSize || ((state.crc ^ 0xffffffff) >>> 0) !== entry.crc) throw invalid('ZIP entry CRC mismatch'); files.set(entry.key, state.filePath); active.delete(state); } } catch (e) { failure = e; } };
        file.start();
      } catch (e) { failure = e; }
    }); unzip.register(UnzipInflate); let done = 0; onProgress({ phase: 'extracting', completed: 0, total });
    for (const entry of entries) {
      checkAbort(); active.current = entry; let header = readExact(fd, entry.localOffset, entry.headerLength); header[6] &= ~8; header.writeUInt32LE(entry.crc, 14); header.writeUInt32LE(entry.compressedSize, 18); header.writeUInt32LE(entry.originalSize, 22); unzip.push(entry.compressedSize ? header : Buffer.concat([header, Buffer.from([0])]), false);
      for (let at = entry.dataAt, left = entry.compressedSize; left;) { const n = Math.min(left, limits.chunkBytes); unzip.push(readExact(fd, at, n), false); at += n; left -= n; if (failure) throw failure; checkAbort(); }
      if (failure) throw failure; done += entry.originalSize; onProgress({ phase: 'extracting', completed: done, total });
    }
    active.current = undefined; unzip.push(new Uint8Array(0), true); if (failure) throw failure; if ([...active].some(x => x.out !== undefined)) throw invalid('Truncated ZIP archive');
    checkAbort(); checkSpace('publish', [...files.values()].reduce((n, p) => n + fs.statSync(p).size, 0)); await replaceAllFromFiles([...files].map(([key, sourcePath]) => ({ key, sourcePath }))); onProgress({ phase: 'extracting', completed: total, total, terminal: true }); return { imported: files.size };
  } catch (e) { if (e instanceof SaveFolderZipImportError) throw e; if (e?.code === 'ENOSPC') throw noSpace(); throw invalid(e?.message || 'Unable to import save-folder ZIP');
  } finally { try { if (fd !== undefined) fs.closeSync(fd); } catch {} for (const state of active) try { if (state?.out !== undefined) fs.closeSync(state.out); } catch {} if (ownedDir) await fsp.rm(ownedDir, { recursive: true, force: true }).catch(() => {}); }
}
module.exports = { DEFAULT_SAVE_FOLDER_ZIP_LIMITS, SaveFolderZipImportError, importSaveFolderZip };
