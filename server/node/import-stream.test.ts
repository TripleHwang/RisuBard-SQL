import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const modulePath = './import-stream.cjs'
let roots: string[] = []

async function root() {
  const value = await mkdtemp(join(tmpdir(), 'import-stream-test-'))
  roots.push(value)
  return value
}

async function* chunks(values: Array<Buffer | Uint8Array>) { yield* values }

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((value) => rm(value, { recursive: true, force: true })))
})

describe('spoolSourceToOwnedFile', () => {
  it('spools chunks into a private durable owned file', async () => {
    const { spoolSourceToOwnedFile } = await import(modulePath)
    const stagingRoot = await root()
    const result = await spoolSourceToOwnedFile(chunks([Buffer.from('ab'), new Uint8Array(Buffer.from('cd'))]), {
      stagingRoot, prefix: 'input-', filename: 'payload.bin', maxBytes: 4,
    })
    expect(result.bytes).toBe(4)
    expect(await readFile(result.filePath, 'utf8')).toBe('abcd')
    expect(result.ownedDir).toBe(join(stagingRoot, result.ownedDir.slice(stagingRoot.length + 1)))
    // Windows does not expose POSIX permission bits, but the open call below
    // uses explicit 0600 on every platform.
    if (process.platform !== 'win32') expect((await stat(result.filePath)).mode & 0o777).toBe(0o600)
    expect(await readdir(result.ownedDir)).toEqual(['payload.bin'])
  })

  it('allows exactly maxBytes and cleans the owned directory when exceeded', async () => {
    const { spoolSourceToOwnedFile } = await import(modulePath)
    const stagingRoot = await root()
    await expect(spoolSourceToOwnedFile(chunks([Buffer.alloc(4)]), {
      stagingRoot, prefix: 'limit-', filename: 'input', maxBytes: 4,
    })).resolves.toMatchObject({ bytes: 4 })
    await expect(spoolSourceToOwnedFile(chunks([Buffer.alloc(5)]), {
      stagingRoot, prefix: 'limit-', filename: 'input', maxBytes: 4,
    })).rejects.toMatchObject({ code: 'IMPORT_TOO_LARGE', status: 413 })
    expect(await readdir(stagingRoot)).toHaveLength(1)
  })

  it('checks synchronous capacity before every unknown-length chunk', async () => {
    const { spoolSourceToOwnedFile } = await import(modulePath)
    const stagingRoot = await root(); const calls: Array<{ needed: number }> = []
    await spoolSourceToOwnedFile(chunks([Buffer.alloc(2), Buffer.alloc(3)]), {
      stagingRoot, prefix: 'space-', filename: 'input', maxBytes: 5, diskHeadroomBytes: 7,
      getAvailableBytes: (info: { needed: number }) => { calls.push(info); return info.needed + 7 },
    })
    expect(calls.map((call) => call.needed)).toEqual([2, 3])
  })

  it('rejects insufficient capacity before writing and cleans only its owned directory', async () => {
    const { spoolSourceToOwnedFile } = await import(modulePath)
    const stagingRoot = await root()
    await expect(spoolSourceToOwnedFile(chunks([Buffer.alloc(2)]), {
      stagingRoot, prefix: 'space-', filename: 'input', maxBytes: 2, diskHeadroomBytes: 1,
      getAvailableBytes: () => 2,
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE', status: 507 })
    expect(await readdir(stagingRoot)).toEqual([])
  })

  it('rejects an aborted source before staging and during ingestion', async () => {
    const { spoolSourceToOwnedFile } = await import(modulePath)
    const stagingRoot = await root(); const before = new AbortController(); before.abort()
    await expect(spoolSourceToOwnedFile(chunks([Buffer.from('x')]), {
      stagingRoot, prefix: 'abort-', filename: 'input', maxBytes: 1, signal: before.signal,
    })).rejects.toMatchObject({ code: 'IMPORT_ABORTED', status: 499 })
    const during = new AbortController()
    async function* source() { yield Buffer.from('a'); during.abort(); yield Buffer.from('b') }
    await expect(spoolSourceToOwnedFile(source(), {
      stagingRoot, prefix: 'abort-', filename: 'input', maxBytes: 2, signal: during.signal,
    })).rejects.toMatchObject({ code: 'IMPORT_ABORTED', status: 499 })
    expect(await readdir(stagingRoot)).toEqual([])
  })

  it('maps an ENOSPC write to insufficient storage and removes the owned directory', async () => {
    const { spoolSourceToOwnedFile } = await import(modulePath)
    const stagingRoot = await root(); const fsPromises = require('node:fs/promises'); const realOpen = fsPromises.open
    const openSpy = vi.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args: any[]) => {
      const handle = await realOpen(...args)
      const failure: any = new Error('full'); failure.code = 'ENOSPC'
      return { ...handle, write: async () => { throw failure }, sync: handle.sync.bind(handle), close: handle.close.bind(handle) } as any
    })
    await expect(spoolSourceToOwnedFile(chunks([Buffer.from('x')]), {
      stagingRoot, prefix: 'full-', filename: 'input', maxBytes: 1,
    })).rejects.toMatchObject({ code: 'INSUFFICIENT_STORAGE', status: 507 })
    expect(openSpy).toHaveBeenCalledWith(expect.any(String), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    expect(await readdir(stagingRoot)).toEqual([])
  })

  it('syncs and closes the file after sequential writes before succeeding', async () => {
    const { spoolSourceToOwnedFile } = await import(modulePath)
    const stagingRoot = await root(); const fsPromises = require('node:fs/promises'); const realOpen = fsPromises.open
    const events: string[] = []
    vi.spyOn(fsPromises, 'open').mockImplementationOnce(async (...args: any[]) => {
      const handle = await realOpen(...args)
      return {
        write: async (...writeArgs: any[]) => { events.push('write'); return handle.write(...writeArgs) },
        sync: async () => { events.push('sync'); return handle.sync() },
        close: async () => { events.push('close'); return handle.close() },
      }
    })
    await expect(spoolSourceToOwnedFile(chunks([Buffer.from('a'), Buffer.from('b')]), {
      stagingRoot, prefix: 'durable-', filename: 'input', maxBytes: 2,
    })).resolves.toMatchObject({ bytes: 2 })
    expect(events).toEqual(['write', 'write', 'sync', 'close'])
  })

  it('cleans staging when the source fails and rejects invalid inputs with status 400', async () => {
    const { spoolSourceToOwnedFile } = await import(modulePath)
    const stagingRoot = await root()
    async function* broken() { yield Buffer.from('a'); throw new Error('source failed') }
    await expect(spoolSourceToOwnedFile(broken(), {
      stagingRoot, prefix: 'broken-', filename: 'input', maxBytes: 2,
    })).rejects.toMatchObject({ code: 'INVALID_IMPORT_INPUT', status: 400 })
    expect(await readdir(stagingRoot)).toEqual([])
    await expect(spoolSourceToOwnedFile(chunks([Buffer.from('x')]), {
      stagingRoot, prefix: 'bad-', filename: 'input', maxBytes: -1,
    })).rejects.toMatchObject({ status: 400 })
    await expect(spoolSourceToOwnedFile(chunks([{} as any]), {
      stagingRoot, prefix: 'bad-', filename: 'input', maxBytes: 1,
    })).rejects.toMatchObject({ status: 400 })
  })
})
