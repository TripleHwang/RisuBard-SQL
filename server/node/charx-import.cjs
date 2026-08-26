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
function aborted() { return new CharXImportError('ABORTED', 'CharX import aborted', 499); }

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
  let cardCount = 0, moduleCount = 0, entryCount = 0, compressed = 0, decompressed = 0;
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
    if (state.fd !== undefined) { fs.closeSync(state.fd); state.fd = undefined; }
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
      if (file.size && file.size > limits.decompressedBytes) throw limit('Archive entry exceeds decompressed limit');
      entryCount++;
      if (entryCount > limits.entries) throw limit('Archive has too many entries');
      if (file.name.endsWith('/')) return;
      const rootCard = name === 'card.json';
      const rootModule = name === 'module.risum';
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
        } catch (e) { currentError = e instanceof CharXImportError ? e : invalid('Unable to extract archive entry'); }
      };
      file.start();
    } catch (e) { currentError = e instanceof CharXImportError ? e : invalid('Unable to read archive entry'); }
  });
  unzip.register(UnzipInflate);
  try {
    for await (const input of source) {
      checkAbort();
      const chunk = input instanceof Uint8Array ? input : new Uint8Array(input);
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
    if (active.size) throw invalid('Truncated ZIP archive');
    if (cardCount !== 1 || cards.length !== 1) throw invalid('Archive must contain exactly one card.json');
    const card = utf8Json(cards[0]);
    if (!card || card.spec !== 'chara_card_v3') throw invalid('card.json must be a chara_card_v3 card');
    const moduleBase64 = modules.length ? Buffer.concat(modules[0]).toString('base64') : undefined;
    let stagedBytes = 0;
    for (const sourcePath of assetFiles.values()) stagedBytes += fs.statSync(sourcePath).size;
    await refreshSpace(stagedBytes);
    const published = [...assetFiles.entries()].map(([key, sourcePath]) => ({ key, sourcePath }));
    try { await publishAssets(published); } catch (e) { throw new CharXImportError('PUBLISH_FAILED', 'Unable to publish CharX assets', 500); }
    return { card, moduleBase64, assets, excludedFiles, warnings };
  } catch (e) {
    throw e instanceof CharXImportError ? e : invalid('Unable to import CharX archive');
  } finally {
    for (const state of active) { try { if (state.fd !== undefined) fs.closeSync(state.fd); } catch {} }
    try { await fsp.rm(ownedDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { CharXImportError, DEFAULT_CHARX_LIMITS, importCharXStream };
