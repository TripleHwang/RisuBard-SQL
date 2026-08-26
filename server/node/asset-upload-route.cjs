'use strict';

const fsp = require('node:fs/promises');
const { spoolSourceToOwnedFile } = require('./import-stream.cjs');

const MAX_ASSET_UPLOAD_BYTES = 256 * 1024 * 1024;
const ASSET_UPLOAD_HEADROOM_BYTES = 512 * 1024 * 1024;

function parseContentLength(value) {
  if (value === undefined) return null;
  const text = String(value).trim();
  if (!/^(0|[1-9]\d*)$/.test(text)) return undefined;
  const bytes = Number(text);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

function isSafeAssetKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (!value.startsWith('assets/') || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || value.includes('//')) return false;
  const segments = value.split('/');
  return segments.length > 1 && segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..');
}

function statusFor(error) {
  if (error?.code === 'ENOSPC') return 507;
  return Number.isInteger(error?.status) ? error.status : 500;
}

function messageFor(error) {
  switch (error?.code) {
    case 'IMPORT_LIMIT_EXCEEDED': return 'Asset exceeds the allowed size';
    case 'INSUFFICIENT_STORAGE': return 'Insufficient disk space for asset upload';
    case 'IMPORT_ABORTED': return 'Asset upload aborted';
    default: return 'Unable to upload asset';
  }
}

function createAssetUploadHandler(deps) {
  const {
    checkAuth, checkActiveSession, kvSetManyFromFilesAsync, stagingRoot,
    getAvailableBytes, maxBytes = MAX_ASSET_UPLOAD_BYTES,
    diskHeadroomBytes = ASSET_UPLOAD_HEADROOM_BYTES,
    spoolSourceToOwnedFile: spool = spoolSourceToOwnedFile,
    removeOwnedDir = dir => fsp.rm(dir, { recursive: true, force: true }),
  } = deps;
  return async function assetUploadHandler(req, res) {
    if (!await checkAuth(req, res)) return;
    if (!checkActiveSession(req, res)) return;
    const key = req.headers['x-risu-asset-key'];
    const contentType = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    const contentLength = parseContentLength(req.headers['content-length']);
    if (!isSafeAssetKey(key)) { res.status(400).json({ error: 'Invalid asset key', code: 'INVALID_ASSET_KEY' }); return; }
    if (contentType !== 'application/octet-stream') { res.status(415).json({ error: 'Unsupported asset content-type', code: 'UNSUPPORTED_MEDIA_TYPE' }); return; }
    if (contentLength === undefined) { res.status(400).json({ error: 'Invalid content length', code: 'INVALID_CONTENT_LENGTH' }); return; }
    if (contentLength !== null && contentLength > maxBytes) { res.status(413).json({ error: 'Asset exceeds the allowed size', code: 'IMPORT_LIMIT_EXCEEDED' }); return; }
    try {
      if (getAvailableBytes) {
        const available = getAvailableBytes({ phase: 'preflight', needed: contentLength || 0 });
        if (!Number.isFinite(available) || available < (contentLength || 0) + diskHeadroomBytes) {
          res.status(507).json({ error: 'Insufficient disk space for asset upload', code: 'INSUFFICIENT_STORAGE' }); return;
        }
      }
      const controller = new AbortController();
      const abort = () => controller.abort();
      req.once('aborted', abort);
      req.once('close', () => { if (req.aborted || !req.complete) abort(); });
      let staged;
      try {
        staged = await spool(req, { stagingRoot, prefix: 'asset-upload-', filename: 'asset.bin', maxBytes, diskHeadroomBytes, getAvailableBytes, signal: controller.signal });
        await kvSetManyFromFilesAsync([{ key, sourcePath: staged.filePath }]);
        res.json({ success: true, bytes: staged.bytes });
      } finally {
        if (staged?.ownedDir) await removeOwnedDir(staged.ownedDir);
      }
    } catch (error) {
      const status = statusFor(error);
      res.status(status).json({ error: messageFor(error), code: error?.code || 'ASSET_UPLOAD_FAILED' });
    }
  };
}

module.exports = { MAX_ASSET_UPLOAD_BYTES, ASSET_UPLOAD_HEADROOM_BYTES, isSafeAssetKey, createAssetUploadHandler };
