import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const serverSource = fileURLToPath(new URL('./server.cjs', import.meta.url))
const updaterSource = fileURLToPath(
    new URL('../../scripts/updater.cjs', import.meta.url)
)
const sourceUpdaterSource = fileURLToPath(
    new URL('../../update.sh', import.meta.url)
)

describe('RisuBard release updater target', () => {
    test('checks and downloads releases from rpaddict/RisuBard', () => {
        const server = readFileSync(serverSource, 'utf8')
        const updater = readFileSync(updaterSource, 'utf8')
        const sourceUpdater = readFileSync(sourceUpdaterSource, 'utf8')

        expect(server).toContain("const GITHUB_REPO = 'rpaddict/RisuBard';")
        expect(server).toContain(
            'https://api.github.com/repos/${GITHUB_REPO}/releases/latest'
        )
        expect(updater).toContain("const REPO = 'rpaddict/RisuBard';")
        expect(sourceUpdater).toContain('REPO="rpaddict/RisuBard"')
    })
})
