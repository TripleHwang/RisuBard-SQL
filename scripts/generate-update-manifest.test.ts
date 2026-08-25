import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { generateUpdateManifest } from './generate-update-manifest.mjs'

describe('release update manifest generation', () => {
    test('hashes and identifies only exact portable artifacts', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'risuvault-manifest-'))
        const filename = 'RisuVault-v0.1.0-beta.3-win-x64.zip'
        await writeFile(path.join(directory, filename), 'portable payload')
        await writeFile(path.join(directory, 'unrelated.txt'), 'ignored')

        const manifest = await generateUpdateManifest({
            directory,
            tag: 'v0.1.0-beta.3',
            repository: 'TripleHwang/RisuVault',
        })

        expect(manifest).toMatchObject({ schemaVersion: 1, productId: 'risuvault', channel: 'beta', version: '0.1.0-beta.3' })
        expect(manifest.artifacts).toHaveLength(1)
        expect(manifest.artifacts[0]).toMatchObject({ platform: 'win', arch: 'x64', size: 16 })
        expect(manifest.artifacts[0].sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(manifest.artifacts[0].url).toContain(`/releases/download/v0.1.0-beta.3/${filename}`)
        expect(await readFile(path.join(directory, filename), 'utf8')).toBe('portable payload')
    })
})
