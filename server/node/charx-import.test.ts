import { describe, expect, test, vi } from 'vitest';
import { zipSync, strToU8, Zip, ZipPassThrough } from 'fflate';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { importCharXStream, CharXImportError } = require('./charx-import.cjs');

async function* chunks(bytes: Uint8Array, size = 13) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
}

async function writeLargeCharX(destination: string) {
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(destination);
    const zip = new Zip((error, data, final) => {
      if (error) { reject(error); return; }
      output.write(data);
      if (final) output.end();
    });
    output.once('error', reject); output.once('finish', resolve);
    const card = new ZipPassThrough('card.json'); zip.add(card); card.push(strToU8('{"spec":"chara_card_v3"}'), true);
    const oneMiB = new Uint8Array(1024 * 1024).fill(71);
    for (let assetIndex = 0; assetIndex < 3; assetIndex++) {
      const asset = new ZipPassThrough(`large-${assetIndex}.png`); zip.add(asset);
      for (let part = 0; part < 44; part++) asset.push(oneMiB, part === 43);
    }
    zip.end();
  });
}

describe('importCharXStream', () => {
  test('imports a valid card-only archive and publishes only after validation', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const card = { spec: 'chara_card_v3', name: 'Ada' };
    const archive = zipSync({ 'card.json': strToU8(JSON.stringify(card)) });
    const calls: unknown[] = [];
    try {
      const result = await importCharXStream(chunks(archive), {
        stagingRoot,
        publishAssets: async (entries: unknown[]) => calls.push(entries),
      });
      expect(result.card).toEqual(card);
      expect(result.moduleBase64).toBeNull();
      expect(result.assets).toEqual({});
      expect(calls).toEqual([[]]);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('imports module and content-addressed duplicate assets', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({
      'card.json': strToU8(JSON.stringify({ spec: 'chara_card_v3' })),
      'module.risum': strToU8('module'),
      'a.png': strToU8('pixels'),
      'nested/b.png': strToU8('pixels'),
      'ignored.json': strToU8('{"x":1}'),
    });
    let published: any[] = [];
    try {
      const result = await importCharXStream(chunks(archive), {
        stagingRoot,
        publishAssets: async (entries: any[]) => { published = entries; await Promise.all(entries.map((e) => readFile(e.sourcePath))); },
      });
      expect(result.moduleBase64).toBe(Buffer.from('module').toString('base64'));
      expect(Object.keys(result.assets)).toEqual(['a.png', 'nested/b.png']);
      expect(new Set(Object.values(result.assets)).size).toBe(1);
      expect(published).toHaveLength(1);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test.each([
    ['missing card', { 'x.png': strToU8('x') }],
    ['non-v3 card', { 'card.json': strToU8('{"spec":"v2"}') }],
    ['malformed card', { 'card.json': strToU8('{') }],
    ['unsafe backslash name', { 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a\\b.png': strToU8('x') }],
  ])('rejects %s as INVALID_CHARX', async (_name, files) => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      await expect(importCharXStream(chunks(zipSync(files)), { stagingRoot, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX', status: 400 });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects truncated archives and malformed UTF-8 card text', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const valid = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    const badUtf8 = zipSync({ 'card.json': new Uint8Array([0xc3, 0x28]) });
    try {
      await expect(importCharXStream(chunks(valid.subarray(0, valid.length - 5)), { stagingRoot, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX' });
      await expect(importCharXStream(chunks(badUtf8), { stagingRoot, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('enforces compressed and metadata limits', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8(JSON.stringify({ spec: 'chara_card_v3', text: 'long-value' })) });
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {}, limits: { cardBytes: 3 } }))
        .rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {}, limits: { compressedBytes: 1 } }))
        .rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('excludes an oversized asset but imports the card', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'big.png': strToU8('12345') });
    try {
      const result = await importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {}, limits: { assetBytes: 3 } });
      expect(result.assets).toEqual({});
      expect(result.excludedFiles).toEqual(['big.png']);
      expect(result.warnings).toHaveLength(1);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('ignores directory entries and reports progress while streaming', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'nested/': new Uint8Array(), 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'nested/a.png': strToU8('x') });
    const progress: any[] = [];
    try {
      const result = await importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {}, onProgress: (p: any) => progress.push(p) });
      expect(result.assets['nested/a.png']).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
      expect(progress.length).toBeGreaterThan(1);
      expect(progress.at(-1).compressedBytes).toBe(archive.length);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('checks disk space before import and before publishing assets', async () => {
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('abc') });
    const lowRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const publishRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot: lowRoot, expectedCompressedBytes: archive.length, getAvailableBytes: async () => 0, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE' });
      let calls = 0;
      await expect(importCharXStream(chunks(archive), { stagingRoot: publishRoot, getAvailableBytes: async () => ++calls < 3 ? 999999999 : 0, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE' });
    } finally { await Promise.all([rm(lowRoot, { recursive: true, force: true }), rm(publishRoot, { recursive: true, force: true })]); }
  });

  test('aborts and removes its owned staging directory on publish failure', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('abc') });
    try {
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => { throw new Error('no'); } }))
        .rejects.toMatchObject({ code: 'ASSET_COMMIT_FAILED' });
      expect((await (await import('node:fs/promises')).readdir(stagingRoot))).toEqual([]);
      const controller = new AbortController(); controller.abort();
      await expect(importCharXStream(chunks(archive), { stagingRoot, signal: controller.signal, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'IMPORT_ABORTED' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('uses stable abort and asset-commit error codes and null for no module', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    try {
      const controller = new AbortController(); controller.abort();
      await expect(importCharXStream(chunks(archive), { stagingRoot, signal: controller.signal, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'IMPORT_ABORTED' });
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => { throw new Error('no'); } }))
        .rejects.toMatchObject({ code: 'ASSET_COMMIT_FAILED' });
      await expect(importCharXStream(chunks(archive), { stagingRoot, publishAssets: async () => {} }))
        .resolves.toMatchObject({ moduleBase64: null });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects EOCD central-directory count mismatches', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    // EOCD has total central-directory entry count at -12.
    const corrupt = archive.slice(); corrupt[corrupt.length - 12] = 2;
    try {
      await expect(importCharXStream(chunks(corrupt), { stagingRoot, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('enforces advertised and actual metadata, entry and total decompressed limits', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const base = { 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'module.risum': strToU8('module'), 'a.png': strToU8('asset') };
    try {
      await expect(importCharXStream(chunks(zipSync(base)), { stagingRoot, publishAssets: async () => {}, limits: { entries: 2 } })).rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
      await expect(importCharXStream(chunks(zipSync(base)), { stagingRoot, publishAssets: async () => {}, limits: { moduleBytes: 2 } })).rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
      await expect(importCharXStream(chunks(zipSync(base)), { stagingRoot, publishAssets: async () => {}, limits: { decompressedBytes: 3 } })).rejects.toMatchObject({ code: 'CHARX_LIMIT_EXCEEDED' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test.each(['../a.png', '/a.png', 'C:a.png', 'a\\b.png', 'a/./b.png', 'a/../b.png'])('rejects unsafe name %s', async (name) => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      await expect(importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), [name]: strToU8('x') })), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects NFC duplicate names while preserving case-sensitive names', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    try {
      await expect(importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'é.png': strToU8('x'), 'é.png': strToU8('y') })), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
      await expect(importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('x'), 'A.png': strToU8('y') })), { stagingRoot, publishAssets: async () => {} })).resolves.toMatchObject({ assets: expect.objectContaining({ 'a.png': expect.any(String), 'A.png': expect.any(String) }) });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('maps staging ENOSPC to insufficient storage and cleans staging', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const fs = require('node:fs');
    const spy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => { const e: any = new Error('full'); e.code = 'ENOSPC'; throw e; });
    try {
      await expect(importCharXStream(chunks(zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': strToU8('x') })), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE', status: 507 });
      expect(await (await import('node:fs/promises')).readdir(stagingRoot)).toEqual([]);
    } finally { spy.mockRestore(); await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('stops a source at the next iteration when it is aborted mid-stream', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}'), 'a.png': new Uint8Array(100_000) });
    const controller = new AbortController(); let yielded = 0;
    async function* source() { for (let at = 0; at < archive.length; at += 10) { yielded++; yield archive.subarray(at, at + 10); if (yielded === 1) controller.abort(); } }
    try {
      await expect(importCharXStream(source(), { stagingRoot, signal: controller.signal, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'IMPORT_ABORTED' });
      // Async iteration obtains at most one next chunk before the loop observes abort.
      expect(yielded).toBe(2);
      expect(await (await import('node:fs/promises')).readdir(stagingRoot)).toEqual([]);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('rejects encrypted and unsupported-compression local entries', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archive = zipSync({ 'card.json': strToU8('{"spec":"chara_card_v3"}') });
    const encrypted = archive.slice(); encrypted[6] |= 1;
    const unsupported = archive.slice(); unsupported[8] = 99;
    try {
      await expect(importCharXStream(chunks(encrypted), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
      await expect(importCharXStream(chunks(unsupported), { stagingRoot, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_CHARX' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });

  test('imports a 132 MiB archive from an fs stream without retaining archive data', async () => {
    const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
    const archivePath = join(stagingRoot, 'large.charx');
    try {
      await writeLargeCharX(archivePath);
      let maxReadChunk = 0;
      const source = createReadStream(archivePath, { highWaterMark: 64 * 1024 });
      source.on('data', (chunk) => { maxReadChunk = Math.max(maxReadChunk, chunk.length); });
      const result = await importCharXStream(source, {
        stagingRoot,
        publishAssets: async (entries: any[]) => { await Promise.all(entries.map((entry) => readFile(entry.sourcePath))); },
      });
      expect(Object.keys(result.assets)).toHaveLength(3);
      expect(maxReadChunk).toBeLessThanOrEqual(64 * 1024);
      expect((await (await import('node:fs/promises')).readdir(stagingRoot)).sort()).toEqual(['large.charx']);
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  }, 120_000);
});
