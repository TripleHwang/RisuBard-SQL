import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const importer = './risum-import.cjs'
const clientMapPath = fileURLToPath(new URL('../../src/ts/rpack/rpack_map.bin', import.meta.url))
const roots: string[] = []

async function root() { const dir = await mkdtemp(join(tmpdir(), 'risum-import-test-')); roots.push(dir); return dir }
async function encode(value: Buffer) { const map = (await readFile(clientMapPath)).subarray(0, 256); return Buffer.from(value.map(byte => map[byte])) }
async function writeAll(handle: any, value: Buffer) { let at = 0; while (at < value.length) { const { bytesWritten } = await handle.write(value, at, value.length - at, null); at += bytesWritten } }
async function fixture(module: any, assets: Buffer[] = []) {
  const dir = await root(); const archivePath = join(dir, 'module.risum'); const file = await open(archivePath, 'wx', 0o600)
  try {
    const metadata = await encode(Buffer.from(JSON.stringify({ type: 'risuModule', module })))
    const header = Buffer.alloc(6); header[0] = 111; header[1] = 0; header.writeUInt32LE(metadata.length, 2); await writeAll(file, header); await writeAll(file, metadata)
    for (const asset of assets) { const packed = await encode(asset); const assetHeader = Buffer.alloc(5); assetHeader[0] = 1; assetHeader.writeUInt32LE(packed.length, 1); await writeAll(file, assetHeader); await writeAll(file, packed) }
    await writeAll(file, Buffer.from([0])); await file.sync()
  } finally { await file.close() }
  return { archivePath, stagingRoot: join(dir, 'stage') }
}
async function archiveFixture({ magic = 111, version = 0, metadata = Buffer.from(JSON.stringify({ type: 'risuModule', module: { assets: [] } })), metadataLength, records = [], terminal = true, trailing = Buffer.alloc(0) }: any = {}) {
  const dir = await root(); const archivePath = join(dir, 'custom.risum'); const stagingRoot = join(dir, 'stage'); const file = await open(archivePath, 'wx', 0o600)
  try {
    const packedMetadata = await encode(metadata); const header = Buffer.alloc(6); header[0] = magic; header[1] = version; header.writeUInt32LE(metadataLength ?? packedMetadata.length, 2); await writeAll(file, header); await writeAll(file, packedMetadata)
    for (const record of records) { const packed = await encode(record.data ?? Buffer.alloc(0)); const header = Buffer.alloc(record.omitLength ? 1 : 5); header[0] = record.mark ?? 1; if (!record.omitLength) header.writeUInt32LE(record.length ?? packed.length, 1); await writeAll(file, header); if (!record.omitData) await writeAll(file, packed) }
    if (terminal) await writeAll(file, Buffer.from([0])); if (trailing.length) await writeAll(file, trailing); await file.sync()
  } finally { await file.close() }
  return { archivePath, stagingRoot }
}
async function expectStageEmpty(stagingRoot: string) { await expect(readdir(stagingRoot)).resolves.toEqual([]) }
const testLimits = { compressedBytes: 1024 * 1024, metadataBytes: 4096, entries: 4, assetDecodedBytes: 4096, decodedBytes: 8192, diskHeadroomBytes: 0, ioChunkBytes: 3 }

afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

describe('importRisumFile', () => {
  it('publishes decoded assets under hash keys and rewrites module refs', async () => {
    const sourceModule = { name: 'two assets', assets: [['one', '', 'a'], ['two', '', 'b']] }
    const { archivePath, stagingRoot } = await fixture(sourceModule, [Buffer.from('first'), Buffer.from('second')]); const published: any[] = []; const progress: any[] = []
    const { importRisumFile } = await import(importer)
    const result = await importRisumFile({ archivePath, stagingRoot, limits: testLimits, publishAssets: async (entries: any[]) => { for (const entry of entries) published.push({ ...entry, data: await readFile(entry.sourcePath) }) }, onProgress: (item: any) => progress.push(item) })
    const first = `assets/${createHash('sha256').update('first').digest('hex')}.png`; const second = `assets/${createHash('sha256').update('second').digest('hex')}.png`
    expect(result.module.assets.map((asset: any) => asset[1])).toEqual([first, second]); expect(result.assets).toBe(2)
    expect(published.map(item => item.key)).toEqual([first, second]); expect(published[0].data.toString()).toBe('first')
    expect(progress.map(item => item.completed)).toEqual([...progress.map(item => item.completed)].sort((a, b) => a - b))
  })

  it('accepts a valid module with no asset records', async () => {
    const { archivePath, stagingRoot } = await fixture({ name: 'empty', assets: [] }); const published: any[] = []
    const { importRisumFile } = await import(importer)
    await expect(importRisumFile({ archivePath, stagingRoot, limits: testLimits, publishAssets: async (entries: any[]) => published.push(...entries) })).resolves.toMatchObject({ assets: 0, module: { name: 'empty' } })
    expect(published).toEqual([])
  })

  it('does not publish when a record is truncated or metadata assets do not match', async () => {
    const { archivePath, stagingRoot } = await fixture({ name: 'bad', assets: [] }, [Buffer.from('orphan')]); const published: any[] = []
    const { importRisumFile } = await import(importer)
    await expect(importRisumFile({ archivePath, stagingRoot, limits: testLimits, publishAssets: async (entries: any[]) => published.push(...entries) })).rejects.toMatchObject({ code: 'INVALID_RISUM' })
    expect(published).toEqual([])
  })

  it('rejects invalid headers and cleans owned staging', async () => {
    const dir = await root(); const archivePath = join(dir, 'bad.risum'); const output = await open(archivePath, 'wx'); try { await output.write(Buffer.from([110, 0, 0, 0, 0, 0, 0])); } finally { await output.close() }
    const { importRisumFile } = await import(importer)
    await expect(importRisumFile({ archivePath, stagingRoot: join(dir, 'stage'), limits: testLimits, publishAssets: async () => {} })).rejects.toMatchObject({ code: 'INVALID_RISUM' })
  })

  it.each([
    ['unsupported version', { version: 1 }],
    ['truncated uint32', { records: [{ omitLength: true }], terminal: false }],
    ['out-of-file length', { records: [{ data: Buffer.from('x'), length: 99, omitData: true }], terminal: false }],
    ['invalid UTF-8', { metadata: Buffer.from([0xff]) }],
    ['invalid JSON', { metadata: Buffer.from('{') }],
    ['wrong type', { metadata: Buffer.from(JSON.stringify({ type: 'other', module: { assets: [] } })) }],
  ])('rejects %s without publishing', async (_name, options) => {
    const { archivePath, stagingRoot } = await archiveFixture(options); let calls = 0; const { importRisumFile } = await import(importer)
    await expect(importRisumFile({ archivePath, stagingRoot, limits: testLimits, publishAssets: async () => { calls++ } })).rejects.toMatchObject({ code: 'INVALID_RISUM' })
    expect(calls).toBe(0); await expectStageEmpty(stagingRoot)
  })

  it.each([
    ['metadata', { metadataBytes: 1 }],
    ['entry count', { entries: 0 }],
    ['per asset', { assetDecodedBytes: 2 }],
    ['decoded total', { decodedBytes: 63 }],
  ])('enforces the %s limit before publishing', async (_name, override) => {
    const module = { assets: [['asset', '', 'x']] }; const { archivePath, stagingRoot } = await fixture(module, [Buffer.from('long')]); let calls = 0; const { importRisumFile } = await import(importer)
    await expect(importRisumFile({ archivePath, stagingRoot, limits: { ...testLimits, ...override }, publishAssets: async () => { calls++ } })).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED', status: 413 })
    expect(calls).toBe(0); await expectStageEmpty(stagingRoot)
  })

  it('deduplicates identical decoded assets while preserving both metadata refs', async () => {
    const module = { assets: [['a', '', 'x'], ['b', '', 'y']] }; const { archivePath, stagingRoot } = await fixture(module, [Buffer.from('same'), Buffer.from('same')]); let entries: any[] = []; const { importRisumFile } = await import(importer)
    const result = await importRisumFile({ archivePath, stagingRoot, limits: testLimits, publishAssets: async (value: any[]) => { entries = value } })
    expect(entries).toHaveLength(1); expect(result.module.assets[0][1]).toBe(result.module.assets[1][1])
  })

  it('cleans staging and preserves the publish error when atomic publish rejects', async () => {
    const { archivePath, stagingRoot } = await fixture({ assets: [['a', '', 'x']] }, [Buffer.from('asset')]); const failure: any = new Error('publish failed'); failure.code = 'EIO'; const { importRisumFile } = await import(importer)
    await expect(importRisumFile({ archivePath, stagingRoot, limits: testLimits, publishAssets: async () => { throw failure } })).rejects.toBe(failure)
    await expectStageEmpty(stagingRoot)
  })

  it('checks disk headroom for every decoded asset chunk and cleans the partial file', async () => {
    const { archivePath, stagingRoot } = await fixture({ assets: [['a', '', 'x']] }, [Buffer.from('sixbyt')]); let checks = 0; let calls = 0; const { importRisumFile } = await import(importer)
    await expect(importRisumFile({ archivePath, stagingRoot, limits: { ...testLimits, ioChunkBytes: 2, diskHeadroomBytes: 10 }, getAvailableBytes: ({ phase }: any) => phase === 'asset-chunk' && ++checks >= 2 ? 11 : 100000, publishAssets: async () => { calls++ } })).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE', status: 507 })
    expect(checks).toBeGreaterThanOrEqual(2); expect(calls).toBe(0); await expectStageEmpty(stagingRoot)
  })

  it('aborts during decoded chunks and cleans staging without publishing', async () => {
    const { archivePath, stagingRoot } = await fixture({ assets: [['a', '', 'x']] }, [Buffer.from('sixbyt')]); const controller = new AbortController(); let checks = 0; let calls = 0; const { importRisumFile } = await import(importer)
    await expect(importRisumFile({ archivePath, stagingRoot, limits: { ...testLimits, ioChunkBytes: 2 }, signal: controller.signal, getAvailableBytes: ({ phase }: any) => { if (phase === 'asset-chunk' && ++checks === 2) controller.abort(); return 100000 }, publishAssets: async () => { calls++ } })).rejects.toMatchObject({ code: 'IMPORT_ABORTED', status: 499 })
    expect(calls).toBe(0); await expectStageEmpty(stagingRoot)
  })
})
