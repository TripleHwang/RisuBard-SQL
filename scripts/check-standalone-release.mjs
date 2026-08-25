import { readFileSync } from 'node:fs'

const sources = {
  server: readFileSync('server/node/server.cjs', 'utf8'),
  updater: readFileSync('scripts/updater.cjs', 'utf8'),
  sourceUpdater: readFileSync('update.sh', 'utf8'),
  release: readFileSync('.github/workflows/release.yml', 'utf8'),
}

const requirements = [
  ['server update repository opt-in', sources.server, 'RISU_UPDATE_REPOSITORY'],
  ['portable updater repository opt-in', sources.updater, 'RISU_UPDATE_REPOSITORY'],
  ['source updater repository opt-in', sources.sourceUpdater, 'RISU_UPDATE_REPOSITORY'],
  ['standalone artifact prefix', sources.release, 'RisuBard-SQL'],
  ['standalone repository', sources.release, 'RisuBard-SQL'],
  ['tag/version release gate', sources.release, 'Verify tag matches package version'],
]

const missing = requirements
  .filter(([, source, token]) => !source.includes(token))
  .map(([name]) => name)

if (missing.length > 0) {
  throw new Error(`Standalone release contract is incomplete: ${missing.join(', ')}`)
}
