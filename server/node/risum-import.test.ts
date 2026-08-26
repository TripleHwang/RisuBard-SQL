import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const importer = './risum-import.cjs'
const clientMapPath = '../../src/ts/rpack/rpack_map.bin'
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
})
