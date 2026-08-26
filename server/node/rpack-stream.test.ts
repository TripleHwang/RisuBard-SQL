import { afterEach, describe, expect, it, vi } from 'vitest'
import { constants } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const streamModule = './rpack-stream.cjs'
const mapModule = './rpack-map.cjs'
const clientMapPath = '../../src/ts/rpack/rpack_map.bin'
let roots: string[] = []

async function root() { const value = await mkdtemp(join(tmpdir(), 'rpack-stream-test-')); roots.push(value); return value }
async function fixture(decoded: Buffer) {
  const dir = await root(); const sourcePath = join(dir, 'source.rpack'); const targetPath = join(dir, 'decoded.bin')
  const map = (await readFile(clientMapPath)).subarray(0, 256)
  const encoded = Buffer.from(decoded.map((value) => map[value]))
  await writeFile(sourcePath, encoded)
  return { sourcePath, targetPath, encoded }
}

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true }))) })

describe('RPack server decode map', () => {
  it('is the literal inverse of every client encoder value', async () => {
    const { RPACK_DECODE_MAP } = await import(mapModule)
    const encode = (await readFile(clientMapPath)).subarray(0, 256)
    expect(RPACK_DECODE_MAP).toHaveLength(256)
    for (let value = 0; value < 256; value++) expect(RPACK_DECODE_MAP[encode[value]]).toBe(value)
  })
})

describe('decodeRPackRangeToFile', () => {
  it.each([1, 3, 64 * 1024])('decodes every byte through bounded %i-byte reads', async (chunkSize) => {
    const { decodeRPackRangeToFile } = await import(streamModule)
    const decoded = Buffer.from(Array.from({ length: 256 }, (_, value) => value))
    const { sourcePath, targetPath, encoded } = await fixture(decoded); const progress: any[] = []
    await expect(decodeRPackRangeToFile(sourcePath, targetPath, { start: 0, length: encoded.length, chunkSize, maxOutputBytes: encoded.length, onChunk: (info: any) => progress.push(info) })).resolves.toMatchObject({ bytes: 256, filePath: targetPath })
    expect(await readFile(targetPath)).toEqual(decoded); expect(await readFile(sourcePath)).toEqual(encoded)
    expect(progress.reduce((total, item) => total + item.bytes, 0)).toBe(256)
    if (process.platform !== 'win32') expect((await stat(targetPath)).mode & 0o777).toBe(0o600)
  })

  it('decodes an exact non-aligned source range', async () => {
    const { decodeRPackRangeToFile } = await import(streamModule)
    const decoded = Buffer.from(Array.from({ length: 40 }, (_, value) => value + 10)); const { sourcePath, targetPath } = await fixture(decoded)
    await decodeRPackRangeToFile(sourcePath, targetPath, { start: 7, length: 19, chunkSize: 3, maxOutputBytes: 19 })
    expect(await readFile(targetPath)).toEqual(decoded.subarray(7, 26))
  })

  it('allows exactly maxOutputBytes and rejects excess without leaving a target', async () => {
    const { decodeRPackRangeToFile } = await import(streamModule)
    const { sourcePath, targetPath } = await fixture(Buffer.from('abcdef'))
    await expect(decodeRPackRangeToFile(sourcePath, targetPath, { start: 0, length: 6, chunkSize: 3, maxOutputBytes: 6 })).resolves.toMatchObject({ bytes: 6 })
    const excess = join((await root()), 'excess.bin')
    await expect(decodeRPackRangeToFile(sourcePath, excess, { start: 0, length: 6, chunkSize: 3, maxOutputBytes: 5 })).rejects.toMatchObject({ code: 'IMPORT_LIMIT_EXCEEDED', status: 413 })
    await expect(stat(excess)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    { start: -1, length: 1, chunkSize: 1, maxOutputBytes: 1 }, { start: 0, length: -1, chunkSize: 1, maxOutputBytes: 1 },
    { start: Number.MAX_SAFE_INTEGER, length: 1, chunkSize: 1, maxOutputBytes: 1 }, { start: 0, length: 1, chunkSize: 0, maxOutputBytes: 1 },
    { start: 0, length: 1, chunkSize: 1, maxOutputBytes: -1 }, { start: 2, length: 10, chunkSize: 1, maxOutputBytes: 10 },
  ])('rejects invalid, overflow, and out-of-range requests', async (options) => {
    const { decodeRPackRangeToFile } = await import(streamModule); const { sourcePath, targetPath } = await fixture(Buffer.from('abc'))
    await expect(decodeRPackRangeToFile(sourcePath, targetPath, options)).rejects.toMatchObject({ status: 400 })
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects an already aborted signal before creating its output', async () => {
    const { decodeRPackRangeToFile } = await import(streamModule); const { sourcePath, targetPath } = await fixture(Buffer.from('abc')); const controller = new AbortController(); controller.abort()
    await expect(decodeRPackRangeToFile(sourcePath, targetPath, { start: 0, length: 3, chunkSize: 1, maxOutputBytes: 3, signal: controller.signal })).rejects.toMatchObject({ code: 'IMPORT_ABORTED', status: 499 })
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('aborts while a read is blocked and cleans its partial output', async () => {
    const { decodeRPackRangeToFile } = await import(streamModule); const { sourcePath, targetPath } = await fixture(Buffer.alloc(3)); const controller = new AbortController()
    const fsPromises = require('node:fs/promises'); const realOpen = fsPromises.open
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await realOpen(...args)
      if (args[1] === constants.O_RDONLY) return { read: () => new Promise(() => {}), close: handle.close.bind(handle) }
      return handle
    })
    const pending = decodeRPackRangeToFile(sourcePath, targetPath, { start: 0, length: 3, chunkSize: 1, maxOutputBytes: 3, signal: controller.signal }); controller.abort()
    await expect(Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error('abort did not settle')), 200))])).rejects.toMatchObject({ code: 'IMPORT_ABORTED', status: 499 })
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves write and fsync failures while removing partial output', async () => {
    const { decodeRPackRangeToFile } = await import(streamModule); const { sourcePath, targetPath } = await fixture(Buffer.from('abc')); const fsPromises = require('node:fs/promises'); const realOpen = fsPromises.open
    const writeFailure: any = new Error('write failed'); writeFailure.code = 'EIO'
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await realOpen(...args)
      if (args[1] !== constants.O_RDONLY) return { write: async () => { throw writeFailure }, close: handle.close.bind(handle) }
      return handle
    })
    await expect(decodeRPackRangeToFile(sourcePath, targetPath, { start: 0, length: 3, chunkSize: 1, maxOutputBytes: 3 })).rejects.toBe(writeFailure)
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' }); vi.restoreAllMocks()
    const syncFailure: any = new Error('sync failed'); syncFailure.code = 'EIO'
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args: any[]) => {
      const handle = await realOpen(...args)
      if (args[1] !== constants.O_RDONLY) return { write: handle.write.bind(handle), sync: async () => { throw syncFailure }, close: handle.close.bind(handle) }
      return handle
    })
    await expect(decodeRPackRangeToFile(sourcePath, targetPath, { start: 0, length: 3, chunkSize: 1, maxOutputBytes: 3 })).rejects.toBe(syncFailure)
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('creates target exclusively', async () => {
    const { decodeRPackRangeToFile } = await import(streamModule); const { sourcePath, targetPath } = await fixture(Buffer.from('abc')); await writeFile(targetPath, 'keep')
    await expect(decodeRPackRangeToFile(sourcePath, targetPath, { start: 0, length: 3, chunkSize: 1, maxOutputBytes: 3 })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(targetPath, 'utf8')).toBe('keep')
  })
})
