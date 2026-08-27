import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, open, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { Zip, ZipPassThrough, strToU8 } from 'fflate'

const importerPath = './risum-import.cjs'
const rpackMapPath = './rpack-map.cjs'
const MiB = 1024 ** 2
const GiB = 1024 ** 3
const WRITE_CHUNK_BYTES = 64 * 1024
const roots: string[] = []

type HarnessMetrics = {
  archiveBytes: number
  assets: number
  decodedBytes: number
  elapsedMs: number
  peakRssIncrease: number
  publishedBytes: number
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, value: Buffer) {
  let offset = 0
  while (offset < value.length) {
    const { bytesWritten } = await handle.write(value, offset, value.length - offset, null)
    if (bytesWritten <= 0) throw new Error('Unable to write generated risum fixture')
    offset += bytesWritten
  }
}

function createEncodeMap(decodeMap: Buffer) {
  const encodeMap = Buffer.allocUnsafe(256)
  for (let encoded = 0; encoded < decodeMap.length; encoded++) {
    encodeMap[decodeMap[encoded]] = encoded
  }
  return encodeMap
}

function encode(value: Buffer, encodeMap: Buffer) {
  const encoded = Buffer.allocUnsafe(value.length)
  for (let index = 0; index < value.length; index++) encoded[index] = encodeMap[value[index]]
  return encoded
}

async function writeGeneratedRisum(archivePath: string, assetSizes: number[]) {
  const { RPACK_DECODE_MAP } = await import(rpackMapPath)
  const encodeMap = createEncodeMap(RPACK_DECODE_MAP)
  const module = {
    name: 'generated large import harness',
    assets: assetSizes.map((_, index) => [`asset-${index}`, '', `generated-${index}`]),
  }
  const metadata = encode(Buffer.from(JSON.stringify({ type: 'risuModule', module })), encodeMap)
  const handle = await open(archivePath, 'wx', 0o600)
  try {
    const archiveHeader = Buffer.alloc(6)
    archiveHeader[0] = 111
    archiveHeader[1] = 0
    archiveHeader.writeUInt32LE(metadata.length, 2)
    await writeAll(handle, archiveHeader)
    await writeAll(handle, metadata)

    for (let index = 0; index < assetSizes.length; index++) {
      const assetBytes = assetSizes[index]
      const recordHeader = Buffer.alloc(5)
      recordHeader[0] = 1
      recordHeader.writeUInt32LE(assetBytes, 1)
      await writeAll(handle, recordHeader)

      const encodedByte = encodeMap[index % 256]
      const chunk = Buffer.alloc(Math.min(WRITE_CHUNK_BYTES, assetBytes), encodedByte)
      let remaining = assetBytes
      while (remaining > 0) {
        const bytes = Math.min(remaining, chunk.length)
        await writeAll(handle, bytes === chunk.length ? chunk : chunk.subarray(0, bytes))
        remaining -= bytes
      }
    }

    await writeAll(handle, Buffer.from([0]))
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function runHarness(assetSizes: number[]): Promise<HarnessMetrics> {
  const root = await mkdtemp(join(tmpdir(), 'risum-large-harness-'))
  roots.push(root)
  const archivePath = join(root, 'generated.risum')
  const stagingRoot = join(root, 'stage')
  await writeGeneratedRisum(archivePath, assetSizes)

  const baselineRss = process.memoryUsage().rss
  let peakRss = baselineRss
  const started = performance.now()
  const timer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
  }, 100)
  timer.unref()

  let publishedBytes = 0
  try {
    const { importRisumFile } = await import(importerPath)
    const result = await importRisumFile({
      archivePath,
      stagingRoot,
      publishAssets: async (entries: Array<{ sourcePath: string }>) => {
        for (const entry of entries) publishedBytes += (await stat(entry.sourcePath)).size
      },
    })
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    expect(await readdir(stagingRoot)).toEqual([])
    return {
      archiveBytes: (await stat(archivePath)).size,
      assets: result.assets,
      decodedBytes: result.decodedBytes,
      elapsedMs: performance.now() - started,
      peakRssIncrease: Math.max(0, peakRss - baselineRss),
      publishedBytes,
    }
  } finally {
    clearInterval(timer)
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('generated large risum import harness', () => {
  it('executes the streaming parser with a generated 128 MiB asset', async () => {
    const metrics = await runHarness([128 * MiB])
    expect(metrics.assets).toBe(1)
    expect(metrics.publishedBytes).toBe(128 * MiB)
    expect(metrics.decodedBytes).toBeGreaterThanOrEqual(128 * MiB)
    expect(metrics.peakRssIncrease).toBeLessThanOrEqual(512 * MiB)
    console.info('large-import-harness', JSON.stringify(metrics))
  }, 120_000)

  const largeIt = process.env.RISU_RUN_LARGE_IMPORT === '1' ? it : it.skip
  largeIt('imports a generated 3 GiB risum with bounded RSS', async () => {
    const metrics = await runHarness(Array.from({ length: 12 }, () => 256 * MiB))
    expect(metrics.assets).toBe(12)
    expect(metrics.publishedBytes).toBe(3 * GiB)
    expect(metrics.decodedBytes).toBeGreaterThanOrEqual(3 * GiB)
    expect(metrics.archiveBytes).toBeGreaterThan(3 * GiB)
    expect(metrics.peakRssIncrease).toBeLessThanOrEqual(512 * MiB)
    console.info('large-import-harness', JSON.stringify(metrics))
  }, 15 * 60_000)
})

async function writeGeneratedCharX(archivePath: string, assetBytes: number) {
  const expected = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
    const zip = new Zip((error, data, final) => {
      if (error) { reject(error); return }
      output.write(data)
      if (final) output.end()
    })
    output.once('error', reject)
    output.once('finish', resolve)
    const card = new ZipPassThrough('card.json')
    zip.add(card)
    card.push(strToU8('{"spec":"chara_card_v3"}'), true)
    const asset = new ZipPassThrough('generated-large.png')
    zip.add(asset)
    const chunk = Buffer.alloc(64 * 1024)
    for (let index = 0; index < chunk.length; index++) chunk[index] = index & 0xff
    let remaining = assetBytes
    while (remaining > 0) {
      const bytes = Math.min(remaining, chunk.length)
      const next = bytes === chunk.length ? chunk : chunk.subarray(0, bytes)
      expected.update(next)
      asset.push(next, bytes === remaining)
      remaining -= bytes
    }
    zip.end()
  })
  return expected.digest('hex')
}

const largeCharXIt = process.env.RISU_RUN_LARGE_IMPORT === '1' ? it : it.skip
describe('generated large CharX import harness', () => {
  largeCharXIt('streams a >256 MiB archive and >50 MiB asset without retaining either in memory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'charx-large-harness-'))
    roots.push(root)
    const archivePath = join(root, 'generated.charx')
    const stagingRoot = join(root, 'stage')
    const assetBytes = 257 * MiB
    const expectedDigest = await writeGeneratedCharX(archivePath, assetBytes)
    expect((await stat(archivePath)).size).toBeGreaterThan(256 * MiB)

    const baselineRss = process.memoryUsage().rss
    let peakRss = baselineRss
    const timer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss) }, 100)
    timer.unref()
    try {
      const { importCharXStream } = require('./charx-import.cjs')
      let publishedBytes = 0
      let publishedDigest = ''
      const result = await importCharXStream(createReadStream(archivePath, { highWaterMark: 64 * 1024 }), {
        stagingRoot,
        publishAssets: async (entries: Array<{ sourcePath: string }>) => {
          expect(entries).toHaveLength(1)
          const digest = createHash('sha256')
          for await (const chunk of createReadStream(entries[0].sourcePath, { highWaterMark: 64 * 1024 })) {
            publishedBytes += chunk.length
            digest.update(chunk)
          }
          publishedDigest = digest.digest('hex')
        },
      })
      peakRss = Math.max(peakRss, process.memoryUsage().rss)
      expect(Object.keys(result.assets)).toEqual(['generated-large.png'])
      expect(publishedBytes).toBe(assetBytes)
      expect(publishedDigest).toBe(expectedDigest)
      expect(peakRss - baselineRss).toBeLessThanOrEqual(512 * MiB)
      expect(await readdir(stagingRoot)).toEqual([])
      console.info('charx-large-import-harness', JSON.stringify({ archiveBytes: (await stat(archivePath)).size, publishedBytes, peakRssIncrease: peakRss - baselineRss }))
    } finally {
      clearInterval(timer)
    }
  }, 15 * 60_000)
})
