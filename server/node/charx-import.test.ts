import { describe, expect, test } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { importCharXStream, CharXImportError } = require('./charx-import.cjs');

async function* chunks(bytes: Uint8Array, size = 13) {
  for (let at = 0; at < bytes.length; at += size) yield bytes.subarray(at, at + size);
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
      expect(result.moduleBase64).toBeUndefined();
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
        .rejects.toMatchObject({ code: 'PUBLISH_FAILED' });
      expect((await (await import('node:fs/promises')).readdir(stagingRoot))).toEqual([]);
      const controller = new AbortController(); controller.abort();
      await expect(importCharXStream(chunks(archive), { stagingRoot, signal: controller.signal, publishAssets: async () => {} }))
        .rejects.toMatchObject({ code: 'ABORTED' });
    } finally { await rm(stagingRoot, { recursive: true, force: true }); }
  });
});
