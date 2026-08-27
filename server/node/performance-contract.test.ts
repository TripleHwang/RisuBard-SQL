import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from './performance-fixture.cjs'
import relational from './relational-sqlite.cjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function createProfile(messages: number) {
    const root = await mkdtemp(join(tmpdir(), 'risuvault-contract-'))
    roots.push(root)
    fixture.createReferenceFixture(root, { characters: 2, messages, logicalAssetBytes: 20 * 1024 ** 3 })
    return relational.createRelationalSqlite({ dataRoot: root })
}

test('keeps bootstrap payload independent of generated message count and pages messages', async () => {
    const smaller = await createProfile(20_000)
    const larger = await createProfile(40_000)
    try {
        const smallBootstrap = JSON.stringify(smaller.bootstrap())
        const largeBootstrap = JSON.stringify(larger.bootstrap())
        expect(smallBootstrap.length).toBeLessThan(2_000_000)
        expect(largeBootstrap.length).toBe(smallBootstrap.length)
        expect(JSON.stringify(smaller.bootstrap())).not.toContain('message_extension_nodes')
        expect(JSON.stringify(smaller.bootstrap())).not.toContain('unloaded-sentinel')
        expect(smaller.bootstrap()).not.toHaveProperty('pluginCustomStorage')
        expect(smaller.bootstrap()).not.toHaveProperty('botPresets')
        expect(smaller.bootstrap().settings).not.toHaveProperty('plugins')
        expect(smaller.deferredBootstrap()).toHaveProperty('pluginCustomStorage')
        expect(smaller.deferredBootstrap()).toHaveProperty('botPresets')
        expect(smaller.bootstrap()).toBe(smaller.bootstrap())

        const page = larger.loadChatMessages('reference-chat-000', undefined, 40)
        expect(page.messages).toHaveLength(40)
        expect(page.messages).not.toContainEqual(expect.objectContaining({ content: expect.stringContaining('unloaded-sentinel') }))
    } finally {
        smaller.close()
        larger.close()
    }
})
