import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('release artifact contract', () => {
    it('declares GPLv3 and redistributes the license and inherited notice', () => {
        const packageJson = JSON.parse(readFileSync(
            resolve('package.json'),
            'utf8',
        )) as { license?: string }
        const workflow = readFileSync(
            resolve('.github/workflows/release.yml'),
            'utf8',
        )

        expect(packageJson.license).toBe('GPL-3.0-only')
        expect(workflow).toMatch(/^\s+LICENSE\s*$/m)
        expect(workflow).toMatch(/^\s+NOTICE\.md\s*$/m)
    })

    it('ships runtime source trees and smoke-tests the portable server', () => {
        const workflow = readFileSync(
            resolve('.github/workflows/release.yml'),
            'utf8',
        )

        expect(workflow).toMatch(/^\s+packages\/risubard-core\/\s*$/m)
        expect(workflow).toMatch(/^\s+src\/ts\/risubard\/\s*$/m)
        expect(workflow).toContain('name: Smoke test portable server')
        expect(workflow).toContain('node server/node/server.cjs')
    })
})
