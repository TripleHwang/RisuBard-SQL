import { afterEach, expect, test } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fixture from './performance-fixture.cjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

test('creates the v0.3.1 reference profile deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'risuvault-perf-'))
    roots.push(root)
    const options = { characters: 200, messages: 20_000, logicalAssetBytes: 20 * 1024 ** 3 }

    expect(fixture.createReferenceFixture(root, options)).toEqual(options)
    expect(fixture.inspectReferenceFixture(root)).toEqual(options)
})

test('rejects profiles that would produce uneven generated chat histories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'risuvault-perf-'))
    roots.push(root)
    expect(() => fixture.createReferenceFixture(root, { characters: 3, messages: 10, logicalAssetBytes: 0 })).toThrow(/divide evenly/)
})
