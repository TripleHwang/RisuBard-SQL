import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

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
  ['standalone artifact prefix', sources.release, 'RisuVault'],
  ['standalone repository', sources.release, 'RisuVault'],
  ['tag/version release gate', sources.release, 'Verify tag matches package version'],
]

const missing = requirements
  .filter(([, source, token]) => !source.includes(token))
  .map(([name]) => name)

if (missing.length > 0) {
  throw new Error(`Standalone release contract is incomplete: ${missing.join(', ')}`)
}

// --- Every relative require() in the shipped server code must resolve to a
// file the release artifact actually contains. ---------------------------
//
// The portable/docker packaging paths don't ship the whole repo -- they ship
// an explicit allowlist of directories/files (see the "Upload build
// artifact" step below). server/node/server.cjs is plain, un-bundled CJS
// that runs verbatim from wherever it's unpacked, so a relative require()
// that walks outside that allowlist (e.g. `require('../../shared/x.cjs')`
// pointing at a top-level `shared/` directory nobody remembered to add to
// the artifact list) throws MODULE_NOT_FOUND at runtime -- but only once
// something actually launches the unpacked server, which normal `pnpm test`
// and `pnpm build` never do. This turns that into a build-time failure
// instead of a release-time one.

function extractUploadArtifactPaths(releaseYmlRaw) {
  const releaseYml = releaseYmlRaw.replace(/\r\n/g, '\n')
  const marker = 'name: Upload build artifact'
  const markerIndex = releaseYml.indexOf(marker)
  if (markerIndex === -1) {
    throw new Error(`Could not find "${marker}" step in release.yml`)
  }
  const pathBlockMatch = releaseYml.slice(markerIndex).match(/\n(\s*)path: \|\n([\s\S]*?)\n\1[A-Za-z-]/)
  if (!pathBlockMatch) {
    throw new Error('Could not find a "path: |" block under the "Upload build artifact" step in release.yml')
  }
  return pathBlockMatch[2]
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

const shippedEntries = extractUploadArtifactPaths(sources.release)
const shippedDirs = shippedEntries.filter((e) => e.endsWith('/')).map((e) => e.slice(0, -1))
const shippedFiles = new Set(shippedEntries.filter((e) => !e.endsWith('/')))

function isShipped(repoRelativePath) {
  const posixPath = repoRelativePath.split('\\').join('/')
  if (shippedFiles.has(posixPath)) return true
  return shippedDirs.some((dir) => posixPath === dir || posixPath.startsWith(`${dir}/`))
}

function listCjsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      if (entry === 'node_modules') continue
      out.push(...listCjsFiles(full))
    } else if (entry.endsWith('.cjs')) {
      out.push(full)
    }
  }
  return out
}

function findRelativeRequires(source) {
  const requires = []
  const re = /require\(\s*(['"])(\.[^'"]+)\1\s*\)/g
  let m
  while ((m = re.exec(source))) requires.push(m[2])
  return requires
}

function resolveRequireTarget(fromFile, requirePath) {
  const base = resolve(dirname(fromFile), requirePath)
  const candidates = [base, `${base}.cjs`, `${base}.js`, join(base, 'index.cjs'), join(base, 'index.js')]
  return candidates.find((c) => existsSync(c) && statSync(c).isFile())
}

const violations = []
for (const file of listCjsFiles(resolve('server'))) {
  for (const requirePath of findRelativeRequires(readFileSync(file, 'utf8'))) {
    const resolved = resolveRequireTarget(file, requirePath)
    const repoRelativeFrom = relative(process.cwd(), file).split('\\').join('/')
    if (!resolved) {
      violations.push(`${repoRelativeFrom}: require('${requirePath}') does not resolve to any file on disk`)
      continue
    }
    const repoRelativeTarget = relative(process.cwd(), resolved).split('\\').join('/')
    if (!isShipped(repoRelativeTarget)) {
      violations.push(
        `${repoRelativeFrom}: require('${requirePath}') resolves to ${repoRelativeTarget}, which the ` +
        `"Upload build artifact" step in .github/workflows/release.yml does not ship. Either move the ` +
        `module under a directory that step already ships (e.g. server/node/), or add its path to that ` +
        `step's artifact list.`,
      )
    }
  }
}

if (violations.length > 0) {
  throw new Error(`Standalone release contract is incomplete:\n  - ${violations.join('\n  - ')}`)
}
