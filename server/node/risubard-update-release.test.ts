import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const serverSource = fileURLToPath(new URL('./server.cjs', import.meta.url))
const updaterSource = fileURLToPath(
    new URL('../../scripts/updater.cjs', import.meta.url)
)
const sourceUpdaterSource = fileURLToPath(
    new URL('../../update.sh', import.meta.url)
)
const mainMenuSource = fileURLToPath(
    new URL('../../src/lib/UI/MainMenu.svelte', import.meta.url)
)
const bootstrapSource = fileURLToPath(
    new URL('../../src/ts/bootstrap.ts', import.meta.url)
)
const publicStatsSource = fileURLToPath(
    new URL('../../src/ts/publicStats.ts', import.meta.url)
)
const updaterDocsSource = fileURLToPath(
    new URL('../../docs/architecture/automatic-updater.md', import.meta.url)
)
const languageSources = ['en.ts', 'ko.ts', 'zh-Hant.ts'].map(name =>
    fileURLToPath(new URL(`../../src/lang/${name}`, import.meta.url))
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

    test('does not expose inherited upstream public statistics', () => {
        const server = readFileSync(serverSource, 'utf8')
        const mainMenu = readFileSync(mainMenuSource, 'utf8')
        const bootstrap = readFileSync(bootstrapSource, 'utf8')
        const updaterDocs = readFileSync(updaterDocsSource, 'utf8')
        const languages = languageSources.map(source => readFileSync(source, 'utf8'))
        const offenders = [
            existsSync(publicStatsSource) && 'src/ts/publicStats.ts',
            server.includes('PUBLIC_STATS_URL') && 'server PUBLIC_STATS_URL',
            server.includes("app.get('/api/public-stats'") && 'server /api/public-stats',
            mainMenu.includes('publicStatsStore') && 'MainMenu publicStatsStore',
            bootstrap.includes('fetchPublicStats') && 'bootstrap fetchPublicStats',
            updaterDocs.includes('RISU_PUBLIC_STATS_URL') && 'updater docs public stats',
            updaterDocs.includes('공개 통계') && 'updater docs public stats wording',
            ...languages.flatMap((source, index) =>
                ['statsUsersToday', 'statsYesterday', 'statsVisitsToday']
                    .filter(key => source.includes(key))
                    .map(key => `${languageSources[index]}: ${key}`)
            ),
        ].filter(Boolean)

        expect(offenders).toEqual([])
    })
})
