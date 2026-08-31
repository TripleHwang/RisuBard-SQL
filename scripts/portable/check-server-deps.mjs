// Fails when scripts/portable/server-deps/package.json no longer matches what
// gen-server-deps.cjs derives from the server's require graph.
//
// The portable packages and the Docker image install from that committed
// manifest instead of the app's package.json, so a stale manifest ships a
// server missing a dependency it started using. Run in CI (pr-check.yml) and
// again at release time against the packaged tree.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const committedPath = path.join(here, 'server-deps', 'package.json')
const generator = path.join(here, 'gen-server-deps.cjs')

const outDir = mkdtempSync(path.join(tmpdir(), 'server-deps-check-'))
try {
    execFileSync(process.execPath, [generator, repoRoot, outDir], {
        stdio: 'inherit',
    })
    // Normalize line endings: Windows checkouts may carry the committed file as CRLF.
    const generated = readFileSync(path.join(outDir, 'package.json'), 'utf8')
        .replace(/\r\n/g, '\n')
    const committed = readFileSync(committedPath, 'utf8').replace(/\r\n/g, '\n')
    if (generated !== committed) {
        console.error(
            '\nscripts/portable/server-deps/package.json is stale — server'
            + ' dependencies changed.'
        )
        console.error('Regenerate it from the repo root:')
        console.error(
            '  node scripts/portable/gen-server-deps.cjs .'
            + ' scripts/portable/server-deps'
        )
        console.error(
            '  pnpm --dir scripts/portable/server-deps install --prod'
            + ' --lockfile-only --ignore-workspace'
        )
        console.error('\n--- committed ---\n' + committed)
        console.error('--- generated ---\n' + generated)
        process.exit(1)
    }
    console.log('\nserver-deps manifest is current.')
} finally {
    rmSync(outDir, { recursive: true, force: true })
}
