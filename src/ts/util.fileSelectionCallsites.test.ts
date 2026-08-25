import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

function productionSources(root: string): string[] {
    const files: string[] = []
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) {
            files.push(...productionSources(path))
        } else if ((path.endsWith('.ts') || path.endsWith('.svelte')) && !path.endsWith('.test.ts')) {
            files.push(path)
        }
    }
    return files
}

describe('selectSingleFile nullable call sites', () => {
    test('guards every assigned selection before direct property access', () => {
        const failures: string[] = []
        const assignment = /(?:(?:const|let)\s+)?([A-Za-z_$][\w$]*)\s*=\s*await\s+selectSingleFile\s*\(/g

        for (const path of productionSources(join(process.cwd(), 'src'))) {
            const source = readFileSync(path, 'utf8')
            for (const match of source.matchAll(assignment)) {
                const name = match[1]
                const start = match.index ?? 0
                const snippet = source.slice(start, start + 2500)
                const directAccess = new RegExp(`\\b${name}\\s*(?:\\.|\\[)`).exec(snippet)
                if (!directAccess) continue

                const beforeAccess = snippet.slice(0, directAccess.index)
                const nullGuard = new RegExp(
                    `if\\s*\\(\\s*(?:!\\s*${name}(?:\\?\\.[^)]*)?|${name}\\s*(?:==|===)\\s*null)\\s*\\)`,
                )
                if (!nullGuard.test(beforeAccess)) {
                    const line = source.slice(0, start).split(/\r?\n/).length
                    failures.push(`${relative(process.cwd(), path)}:${line} (${name})`)
                }
            }
        }

        expect(failures, `unguarded selections:\n${failures.join('\n')}`).toEqual([])
    })
})
