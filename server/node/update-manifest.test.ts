import { createRequire } from 'node:module'
import { describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const {
    DEFAULT_MAX_ARTIFACT_SIZE,
    compareUpdateVersions,
    isAllowedGitHubReleaseUrl,
    validateUpdateManifest,
} = require('./update-manifest.cjs')

const runtime = {
    productId: 'risubard',
    channel: 'stable',
    currentVersion: '1.2.3',
    platform: 'win32',
    arch: 'x64',
    allowedGithubRepositories: ['TripleHwang/RisuVault'],
}

function manifest(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1,
        productId: 'risubard',
        channel: 'stable',
        version: '1.2.4',
        minSupportedVersion: '1.0.0',
        artifacts: [{
            platform: 'win32',
            arch: 'x64',
            size: 1024,
            sha256: 'A'.repeat(64),
            url: 'https://github.com/TripleHwang/RisuVault/releases/download/v1.2.4/RisuBard-win-x64.zip',
        }],
        ...overrides,
    }
}

describe('update manifest validation boundary', () => {
    test('accepts an exact product/channel/platform artifact and normalizes its hash', () => {
        const result = validateUpdateManifest(manifest(), runtime)
        expect(result.valid).toBe(true)
        if (result.valid) expect(result.artifact.sha256).toBe('a'.repeat(64))
    })

    test.each([
        ['productId', { productId: 'haejeok-risuai' }],
        ['channel', { channel: 'beta' }],
    ])('rejects a different %s', (_name, changes) => {
        expect(validateUpdateManifest(manifest(changes), runtime)).toMatchObject({ valid: false })
    })

    test('rejects an absent platform/architecture artifact', () => {
        expect(validateUpdateManifest(manifest({ artifacts: [] }), runtime)).toEqual({
            valid: false,
            reason: 'No artifact matches this platform and architecture',
        })
    })

    test('rejects downgrade and equal versions', () => {
        for (const version of ['1.2.3', '1.2.2']) {
            expect(validateUpdateManifest(manifest({ version }), runtime)).toMatchObject({
                valid: false,
                reason: 'Manifest does not upgrade the current version',
            })
        }
    })

    test('rejects a runtime older than minSupportedVersion', () => {
        expect(validateUpdateManifest(manifest({ minSupportedVersion: '1.2.4' }), runtime)).toMatchObject({
            valid: false,
            reason: 'Current version is below the manifest minimum supported version',
        })
    })

    test('rejects malformed hashes and unsafe sizes', () => {
        for (const artifact of [
            { ...manifest().artifacts[0], sha256: 'not-a-hash' },
            { ...manifest().artifacts[0], size: 0 },
            { ...manifest().artifacts[0], size: DEFAULT_MAX_ARTIFACT_SIZE + 1 },
        ]) {
            expect(validateUpdateManifest(manifest({ artifacts: [artifact] }), runtime)).toMatchObject({ valid: false })
        }
    })

    test('enforces https and the configured GitHub repository', () => {
        const urls = [
            'http://github.com/TripleHwang/RisuVault/releases/download/v1/a.zip',
            'https://github.com/evil/RisuVault/releases/download/v1/a.zip',
            'https://github.com/TripleHwang/RisuVault/blob/main/a.zip',
            'https://objects.githubusercontent.com/a.zip',
            'https://github.com@evil.example/TripleHwang/RisuVault/releases/download/v1/a.zip',
            'https://github.com/TripleHwang/RisuVault/releases/download/v1/%2e%2e%2fevil.zip',
            'https://github.com/TripleHwang/RisuVault/releases/download/v1/a.zip/extra',
            'https://github.com/TripleHwang/RisuVault/releases/download/v1/a.zip?raw=1',
        ]
        for (const url of urls) {
            expect(isAllowedGitHubReleaseUrl(url, runtime.allowedGithubRepositories)).toBe(false)
            expect(validateUpdateManifest(manifest({ artifacts: [{ ...manifest().artifacts[0], url }] }), runtime)).toMatchObject({ valid: false })
        }
    })

    test('supports Haejeok build-number version ordering without mixing formats', () => {
        expect(compareUpdateVersions('b6320', 'b6319')).toBe(1)
        expect(compareUpdateVersions('b6320', '1.2.3')).toBeNull()
    })
})
