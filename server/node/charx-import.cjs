'use strict';

const { Unzip, UnzipInflate } = require('fflate');
const { createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_CHARX_LIMITS = Object.freeze({
  compressedBytes: 256 * 1024 * 1024,
  decompressedBytes: 2 * 1024 * 1024 * 1024,
  entries: 10000,
  cardBytes: 4 * 1024 * 1024,
  moduleBytes: 16 * 1024 * 1024,
  assetBytes: 50 * 1024 * 1024,
  queuedWriteBytes: 8 * 1024 * 1024,
  diskHeadroomBytes: 256 * 1024 * 1024,
});

class CharXImportError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'CharXImportError';
    this.code = code;
    this.status = status;
  }
}

function invalid(message) { return new CharXImportError('INVALID_CHARX', message); }
function limit(message) { return new CharXImportError('CHARX_LIMIT_EXCEEDED', message, 413); }
function noSpace(message = 'Insufficient disk space for CharX import') { return new CharXImportError('INSUFFICIENT_STORAGE', message, 507); }
function aborted() { return new CharXImportError('IMPORT_ABORTED', 'CharX import aborted', 499); }
function normalizeError(error, fallback) {
  if (error instanceof CharXImportError) return error;
  if (error && error.code === 'ENOSPC') return noSpace();
  return fallback || invalid('Unable to import CharX archive');
}

function validateName(name, seen) {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw invalid('Invalid archive entry name');
  const normalized = name.normalize('NFC');
  if (seen.has(normalized)) throw invalid('Duplicate archive entry name');
  seen.add(normalized);
  const components = normalized.endsWith('/') ? normalized.slice(0, -1).split('/') : normalized.split('/');
  if (!components.length || components.some((part) => part === '.' || part === '..' || part === '')) throw invalid('Invalid archive entry name');
  return normalized;
}

function utf8Json(chunks) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { throw invalid('card.json must be valid UTF-8'); }
  try { return JSON.parse(text); } catch { throw invalid('card.json must contain valid JSON'); }
}

async function importCharXStream(source, options) {
  const { stagingRoot, publishAssets, expectedCompressedBytes = 0, getAvailableBytes, onProgress = () => {}, signal } = options || {};
  const limits = { ...DEFAULT_CHARX_LIMITS, ...(options && options.limits) };
  if (!stagingRoot || typeof publishAssets !== 'function') throw new TypeError('stagingRoot and publishAssets are required');
  if (signal && signal.aborted) throw aborted();
  if (expectedCompressedBytes > limits.compressedBytes) throw limit('Compressed archive exceeds limit');
  let available = Infinity;
  const refreshSpace = async (needed) => {
    if (!getAvailableBytes) return;
    available = await getAvailableBytes();
    if (available < needed + limits.diskHeadroomBytes) throw noSpace();
  };
  await refreshSpace(expectedCompressedBytes || 0);

  await fsp.mkdir(stagingRoot, { recursive: true });
  const ownedDir = await fsp.mkdtemp(path.join(stagingRoot, 'charx-'));
  const seen = new Set();
  const cards = [];
  const modules = [];
  const assets = Object.create(null);
  const assetFiles = new Map();
  const excludedFiles = [];
  const warnings = [];
  let cardCount = 0, moduleCount = 0, entryCount = 0, compressed = 0, decompressed = 0, advertisedTotal = 0;
  const zipTail = new Uint8Array(65557); let zipTailLength = 0;
  let currentError;
  let active = new Set();

  const checkAbort = () => { if (signal && signal.aborted) throw aborted(); if (currentError) throw currentError; };
  const useSpace = (bytes) => {
    if (getAvailableBytes) {
      if (available < bytes + limits.diskHeadroomBytes) throw noSpace();
      available -= bytes;
    }
  };
  const closeAsset = (state) => {
    if (state.fd !== undefined) { fs.fsyncSync(state.fd); fs.closeSync(state.fd); state.fd = undefined; }
    if (state.excluded) { try { fs.unlinkSync(state.sourcePath); } catch {} return; }
    const key = state.hash.digest('hex');
    const target = `assets/${key}.png`;
    if (!assetFiles.has(key)) assetFiles.set(key, state.sourcePath);
    else { try { fs.unlinkSync(state.sourcePath); } catch {} }
    assets[state.name] = target;
  };
  const unzip = new Unzip((file) => {
    try {
      checkAbort();
      const name = validateName(file.name, seen);
      const advertised = Number(file.originalSize) || 0;
      advertisedTotal += advertised;
      if (advertisedTotal > limits.decompressedBytes) throw limit('Archive exceeds decompressed limit');
      if (file.size && file.size > limits.decompressedBytes) throw limit('Archive entry exceeds decompressed limit');
      entryCount++;
      if (entryCount > limits.entries) throw limit('Archive has too many entries');
      if (file.name.endsWith('/')) return;
      const rootCard = name === 'card.json';
      const rootModule = name === 'module.risum';
      if (rootCard && advertised > limits.cardBytes) throw limit('card.json exceeds limit');
      if (rootModule && advertised > limits.moduleBytes) throw limit('module.risum exceeds limit');
      if (!rootCard && !rootModule && !name.endsWith('.json') && advertised > limits.assetBytes) {
        excludedFiles.push(name); warnings.push(`Excluded oversized asset: ${name}`);
        file.ondata = (err, data) => {
          if (err) { currentError = invalid('Unsupported or corrupt ZIP entry'); return; }
          decompressed += data.length;
          if (decompressed > limits.decompressedBytes) currentError = limit('Archive exceeds decompressed limit');
        };
        file.start(); return;
      }
      if (rootCard && ++cardCount > 1) throw invalid('Archive must contain exactly one card.json');
      if (rootModule && ++moduleCount > 1) throw invalid('Archive may contain only one module.risum');
      const ignored = (!rootCard && !rootModule && name.endsWith('.json'));
      const state = { name, kind: rootCard ? 'card' : rootModule ? 'module' : ignored ? 'ignored' : 'asset', size: 0, chunks: [], excluded: false, fd: undefined, sourcePath: undefined, hash: undefined };
      if (state.kind === 'asset') {
        state.sourcePath = path.join(ownedDir, `asset-${randomBytes(16).toString('hex')}`);
        state.fd = fs.openSync(state.sourcePath, 'wx');
        state.hash = createHash('sha256');
      }
      active.add(state);
      file.ondata = (err, data, final) => {
        try {
          if (err) throw invalid('Unsupported or corrupt ZIP entry');
          checkAbort();
          decompressed += data.length;
          if (decompressed > limits.decompressedBytes) throw limit('Archive exceeds decompressed limit');
          state.size += data.length;
          if (state.kind === 'card') {
            if (state.size > limits.cardBytes) throw limit('card.json exceeds limit');
            state.chunks.push(Buffer.from(data));
          } else if (state.kind === 'module') {
            if (state.size > limits.moduleBytes) throw limit('module.risum exceeds limit');
            state.chunks.push(Buffer.from(data));
          } else if (state.kind === 'asset' && !state.excluded) {
            if (state.size > limits.assetBytes) {
              state.excluded = true;
              fs.closeSync(state.fd); state.fd = undefined;
              try { fs.unlinkSync(state.sourcePath); } catch {}
              excludedFiles.push(state.name); warnings.push(`Excluded oversized asset: ${state.name}`);
            } else {
              useSpace(data.length);
              fs.writeSync(state.fd, data);
              state.hash.update(data);
            }
          }
          if (final) { active.delete(state); if (state.kind === 'asset') closeAsset(state); else if (state.kind === 'card') cards.push(state.chunks); else if (state.kind === 'module') modules.push(state.chunks); }
        } catch (e) { currentError = normalizeError(e, invalid('Unable to extract archive entry')); }
      };
      file.start();
    } catch (e) { currentError = normalizeError(e, invalid('Unable to read archive entry')); }
  });
  unzip.register(UnzipInflate);
  let signature = 0, headerBytes = 0, flags = 0;
  try {
    for await (const input of source) {
      checkAbort();
      const chunk = input instanceof Uint8Array ? input : new Uint8Array(input);
      // ZIP encryption is unsupported. This is deliberately incremental and only retains a few bytes.
      for (const byte of chunk) {
        if (headerBytes) {
          if (headerBytes <= 2) flags |= byte << ((2 - headerBytes) * 8);
          if (--headerBytes === 0 && (flags & 1)) throw invalid('Encrypted ZIP entries are unsupported');
          continue;
        }
        signature = ((signature << 8) | byte) >>> 0;
        if (signature === 0x504b0304) { headerBytes = 4; flags = 0; }
      }
      if (chunk.length >= zipTail.length) { zipTail.set(chunk.subarray(chunk.length - zipTail.length)); zipTailLength = zipTail.length; }
      else {
        const keep = Math.min(zipTailLength, zipTail.length - chunk.length);
        if (keep) zipTail.copyWithin(0, zipTailLength - keep, zipTailLength);
        zipTail.set(chunk, keep); zipTailLength = keep + chunk.length;
      }
      compressed += chunk.length;
      if (compressed > limits.compressedBytes) throw limit('Compressed archive exceeds limit');
      await refreshSpace(0);
      try { unzip.push(chunk, false); } catch (e) { throw currentError || invalid('Invalid or unsupported ZIP archive'); }
      checkAbort();
      onProgress({ compressedBytes: compressed, decompressedBytes: decompressed });
    }
    try { unzip.push(new Uint8Array(0), true); } catch { throw currentError || invalid('Truncated or invalid ZIP archive'); }
    checkAbort();
    // fflate can finish a local-file stream without its central directory; CharX requires a complete ZIP.
    let eocd = -1;
    for (let i = zipTailLength - 22; i >= 0; i--) {
      if (zipTail[i] === 0x50 && zipTail[i + 1] === 0x4b && zipTail[i + 2] === 0x05 && zipTail[i + 3] === 0x06 && i + 22 + zipTail[i + 20] + (zipTail[i + 21] << 8) === zipTailLength) { eocd = i; break; }
    }
    if (eocd < 0) throw invalid('Truncated or invalid ZIP archive');
    const read16 = (at) => zipTail[at] | (zipTail[at + 1] << 8);
    const read32 = (at) => (zipTail[at] | (zipTail[at + 1] << 8) | (zipTail[at + 2] << 16) | (zipTail[at + 3] * 0x1000000));
    const eocdAbsolute = compressed - zipTailLength + eocd;
    const disk = read16(eocd + 4), centralDisk = read16(eocd + 6);
    const entriesOnDisk = read16(eocd + 8), centralEntries = read16(eocd + 10);
    const centralSize = read32(eocd + 12), centralOffset = read32(eocd + 16);
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== centralEntries || centralEntries !== entryCount || centralOffset + centralSize !== eocdAbsolute) throw invalid('Invalid ZIP central directory');
    if (active.size) throw invalid('Truncated ZIP archive');
    if (cardCount !== 1 || cards.length !== 1) throw invalid('Archive must contain exactly one card.json');
    const card = utf8Json(cards[0]);
    if (!card || card.spec !== 'chara_card_v3') throw invalid('card.json must be a chara_card_v3 card');
    const moduleBase64 = modules.length ? Buffer.concat(modules[0]).toString('base64') : null;
    let stagedBytes = 0;
    for (const sourcePath of assetFiles.values()) stagedBytes += fs.statSync(sourcePath).size;
    await refreshSpace(stagedBytes);
    const published = [...assetFiles.entries()].map(([key, sourcePath]) => ({ key, sourcePath }));
    try { await publishAssets(published); } catch (e) { if (e && e.code === 'ENOSPC') throw noSpace(); throw new CharXImportError('ASSET_COMMIT_FAILED', 'Unable to publish CharX assets', 500); }
    return { card, moduleBase64, assets, excludedFiles, warnings };
  } catch (e) {
    throw normalizeError(e);
  } finally {
    for (const state of active) { try { if (state.fd !== undefined) fs.closeSync(state.fd); } catch {} }
    try { await fsp.rm(ownedDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { CharXImportError, DEFAULT_CHARX_LIMITS, importCharXStream };
