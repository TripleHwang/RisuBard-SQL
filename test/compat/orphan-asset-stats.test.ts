/**
 * Orphan-asset stats (/api/db/stats/characters).
 *
 * Regression coverage for a data-loss bug: character-scoped personas
 * (`character.personas[].icon`, distinct from the global `db.personas[].icon`)
 * used to be invisible to the server's buildUncleanableSet(), so their icons
 * were misclassified as orphaned assets. On the client, the identical miss in
 * getUncleanables() meant cleanChunks() actually deleted those files —
 * server-side this only skews the dashboard's orphan count/size, but the two
 * are computed by the exact same shared walk (shared/assetOwnership.cjs), so
 * this endpoint is the fastest way to prove the walk is correct against a
 * real running server.
 */
import { describe, test, expect, afterAll } from 'vitest'
import { Packr } from 'msgpackr'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'

const servers: ServerHandle[] = []
afterAll(async () => {
  await Promise.allSettled(servers.map(s => s.cleanup()))
})

const MAGIC_RAW = Buffer.from([0, 82, 73, 83, 85, 83, 65, 86, 69, 0, 7])
const packr = new Packr({ useRecords: false })

function encodeRisuDat(data: unknown): Buffer {
  return Buffer.concat([MAGIC_RAW, packr.encode(data)])
}

// Referenced only by a character-scoped persona -- nothing else owns it.
// Before the fix this looked orphaned.
const CHAR_PERSONA_UNIQUE = 'char-persona-unique-aaa.png'
// Referenced only by a global persona -- the case that already worked.
const GLOBAL_PERSONA_UNIQUE = 'global-persona-unique-bbb.png'
// Referenced by BOTH a global persona and a character-scoped persona --
// covers the "shared hash" case the design doc calls out: it must survive
// either way, but should specifically confirm the character side is counted
// as an owner too (not just riding along on the global reference).
const SHARED_HASH = 'shared-hash-ccc.png'
// Referenced by nothing at all -- a real orphan. Must stay classified as one;
// the fix must not make GC (or the stats it mirrors) stop collecting garbage.
const TRULY_ORPHANED = 'truly-orphaned-ddd.png'

const ALL_ASSETS = [CHAR_PERSONA_UNIQUE, GLOBAL_PERSONA_UNIQUE, SHARED_HASH, TRULY_ORPHANED]

function createSeed(): Buffer {
  const database: Record<string, unknown> = {
    characters: [
      {
        name: 'CharWithPersonas',
        chaId: 'test-char-persona-1',
        type: 'character',
        desc: '', firstMessage: 'hi',
        image: '',
        emotionImages: [],
        chats: [{ id: 'chat-1', name: 'Chat', message: [], localLore: [], note: '' }],
        chatPage: 0,
        // Character-scoped personas: the array under test.
        personas: [
          { name: 'CharOnly', icon: `assets/${CHAR_PERSONA_UNIQUE}`, personaPrompt: 'char-only persona' },
          { name: 'CharShared', icon: `assets/${SHARED_HASH}`, personaPrompt: 'char persona sharing an icon with a global one' },
        ],
      },
    ],
    characterOrder: ['test-char-persona-1'],
    // Global personas, for contrast -- these already worked before the fix.
    personas: [
      { name: 'GlobalOnly', icon: `assets/${GLOBAL_PERSONA_UNIQUE}`, personaPrompt: 'global-only persona' },
      { name: 'GlobalShared', icon: `assets/${SHARED_HASH}`, personaPrompt: 'global persona sharing an icon with a character one' },
    ],
    selectedPersona: 0,
  }

  return encodeBackup([
    { name: 'database.risudat', data: encodeRisuDat(database) },
    ...ALL_ASSETS.map(name => ({ name, data: Buffer.from(`fake-bytes-for-${name}`) })),
  ])
}

async function seededServer() {
  const srv = await spawnServer()
  servers.push(srv)
  const client = await createClient(srv.port, srv.password)
  const importResult = await client.importBackup(createSeed())
  expect(importResult.ok).toBe(true)
  return client
}

describe('orphan asset stats', () => {
  test('does not count a character-scoped persona icon as orphaned', async () => {
    const client = await seededServer()
    const res = await client.fetch('/api/db/stats/characters')
    expect(res.ok).toBe(true)
    const json = await res.json() as { orphan: { count: number; totalSize: number } }

    // Only TRULY_ORPHANED has no owner anywhere in the DB. If
    // CHAR_PERSONA_UNIQUE (or SHARED_HASH) were still miscounted, this would
    // be 2 or 3 instead.
    expect(json.orphan.count).toBe(1)
    expect(json.orphan.totalSize).toBe(Buffer.from(`fake-bytes-for-${TRULY_ORPHANED}`).byteLength)
  })

  test('still classifies a real orphan as one (no over-correction)', async () => {
    const client = await seededServer()
    const res = await client.fetch('/api/db/stats/characters')
    const json = await res.json() as { orphan: { count: number } }
    expect(json.orphan.count).toBeGreaterThan(0)
  })
})
