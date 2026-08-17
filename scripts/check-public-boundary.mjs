import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const privateRoots = ['src/ts/novelist', 'src/lib/Novelist']
const publicRoots = ['src', 'server/node']
const directPrivateImport = /(?:src\/ts\/novelist|(?:\.\.\/)+Novelist)(?:\/|['"])/
const privateIdentifier = /novelist|NovelProject|ManuscriptDocument|manuscriptCheckpoint|sourceManuscript/i
const allowedPromptFiles = new Set([
    'server/node/utils.cjs',
    'src/ts/process/templates/templates.ts',
])

function productionFiles(path) {
    if (!existsSync(path)) return []
    if (!statSync(path).isDirectory()) return [path]
    return readdirSync(path).flatMap((name) => {
        const child = resolve(path, name)
        if (statSync(child).isDirectory()) return productionFiles(child)
        if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(name)) return []
        return /\.(?:[cm]?[jt]s|svelte)$/.test(name) ? [child] : []
    })
}

export function collectPublicBoundaryViolations(root = repoRoot) {
    const violations = privateRoots
        .filter((path) => existsSync(resolve(root, path)))
        .map((path) => `private-root:${path}`)

    for (const publicRoot of publicRoots) {
        for (const file of productionFiles(resolve(root, publicRoot))) {
            const path = relative(root, file).replaceAll('\\', '/')
            const source = readFileSync(file, 'utf8')
            if (directPrivateImport.test(source)) {
                violations.push(`private-import:${path}`)
            }
            if (!allowedPromptFiles.has(path) && privateIdentifier.test(source)) {
                violations.push(`private-identifier:${path}`)
            }
        }
    }
    return violations
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const violations = collectPublicBoundaryViolations()
    if (violations.length > 0) {
        console.error(violations.join('\n'))
        process.exitCode = 1
    }
}
