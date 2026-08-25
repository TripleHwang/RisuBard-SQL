import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createClient } from './helpers/client.js'
import { fingerprintAssets, normalizeBackup } from './helpers/normalize.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

interface Fixture {
  id: string
  seed: {
    characterCount: number
    chatsPerCharacter: number
    messagesPerChat: number
    includeAssets: boolean
  }
  expected: {
    characterCount: number
    chatCountPerCharacter: number
    messageCountPerChat: number
    assetCount: number
    personaCount: number
  }
}

const manifestPath = path.resolve(import.meta.dirname, '..', 'fixtures', 'compatibility', 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { schemaVersion: number; fixtures: Fixture[] }
const servers: ServerHandle[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
})

describe('tracked compatibility fixtures', () => {
  test('manifest is versioned and contains at least one non-user-data fixture', () => {
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.fixtures.length).toBeGreaterThan(0)
  })

  test.each(manifest.fixtures)('$id survives legacy import and export', async fixture => {
    const input = createSeedBackup(fixture.seed)
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)

    expect((await client.importBackup(input)).ok).toBe(true)
    const output = await client.exportBackup()
    const normalized = normalizeBackup(output).normalized

    expect(normalized.characterCount).toBe(fixture.expected.characterCount)
    expect(normalized.personaCount).toBe(fixture.expected.personaCount)
    expect(fingerprintAssets(output)).toHaveLength(fixture.expected.assetCount)
    for (const character of normalized.characters) {
      expect(character.chatCount).toBe(fixture.expected.chatCountPerCharacter)
      expect(character.messageCounts).toEqual(
        Array(fixture.expected.chatCountPerCharacter).fill(fixture.expected.messageCountPerChat),
      )
    }
  })
})
