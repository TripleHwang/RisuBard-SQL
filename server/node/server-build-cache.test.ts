import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, describe, expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { isBuildRequired } = require('./server-build-cache.cjs')
const roots: string[] = []
const inputFiles = [
    'index.html',
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    'tsconfig.node.json',
    'vite.config.ts',
    'server/node/risubard-memory-analysis.ts',
    'server/node/risubard-memory-writer.ts',
]

function createProject() {
    const root = join(tmpdir(), `risubard-build-cache-${crypto.randomUUID()}`)
    roots.push(root)
    mkdirSync(join(root, 'dist'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    mkdirSync(join(root, 'public'), { recursive: true })
    mkdirSync(join(root, 'server', 'node'), { recursive: true })
    writeFileSync(join(root, 'dist', 'index.html'), 'built')
    writeFileSync(join(root, 'src', 'app.ts'), 'source')
    for (const filename of inputFiles) {
        writeFileSync(join(root, filename), filename)
    }
    return root
}

function setModifiedAt(path: string, milliseconds: number) {
    const date = new Date(milliseconds)
    utimesSync(path, date, date)
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true })
    }
})

describe('server build cache', () => {
    test('reuses a build that is newer than its inputs', () => {
        const root = createProject()
        setModifiedAt(join(root, 'src', 'app.ts'), 1_000)
        for (const filename of inputFiles) {
            setModifiedAt(join(root, filename), 1_000)
        }
        setModifiedAt(join(root, 'dist', 'index.html'), 2_000)

        expect(isBuildRequired(root)).toBe(false)
    })

    test('requires a build when an input is newer than the output', () => {
        const root = createProject()
        setModifiedAt(join(root, 'dist', 'index.html'), 1_000)
        setModifiedAt(join(root, 'src', 'app.ts'), 2_000)

        expect(isBuildRequired(root)).toBe(true)
    })

    test('requires a build when a bundled server TypeScript module is newer', () => {
        const root = createProject()
        const analysis = join(root, 'server', 'node', 'risubard-memory-analysis.ts')
        setModifiedAt(join(root, 'src', 'app.ts'), 500)
        for (const filename of inputFiles) {
            setModifiedAt(join(root, filename), 500)
        }
        setModifiedAt(join(root, 'dist', 'index.html'), 1_000)
        setModifiedAt(analysis, 2_000)

        expect(isBuildRequired(root)).toBe(true)
    })

    test('requires a build when the output is missing', () => {
        const root = createProject()
        rmSync(join(root, 'dist', 'index.html'))

        expect(isBuildRequired(root)).toBe(true)
    })
})
