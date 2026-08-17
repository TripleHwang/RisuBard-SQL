import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

const sourceRoot = join(process.cwd(), 'src')
const sourceExtensions = new Set(['.css', '.js', '.svelte', '.ts'])
const legacyThemeToken = /var\(\s*--(bgcolor|darkbg|borderc|selected|draculared|textcolor|textcolor2|darkborderc|darkbutton|success|primary)\b/g

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) return sourceFiles(path)
        if (!sourceExtensions.has(extname(entry.name))) return []
        if (/\.(?:test|spec)\.[^.]+$/.test(entry.name)) return []
        return [path]
    })
}

describe('RisuBard UI theme token contract', () => {
    test('rejects undefined legacy theme variables in production UI sources', () => {
        const violations = sourceFiles(sourceRoot).flatMap((path) => {
            const source = readFileSync(path, 'utf8')
            return source.split(/\r?\n/).flatMap((line, index) => {
                legacyThemeToken.lastIndex = 0
                const matches = [...line.matchAll(legacyThemeToken)]
                return matches.map((match) =>
                    `${relative(process.cwd(), path)}:${index + 1} --${match[1]}`
                )
            })
        })

        expect(violations, [
            'Raw UI CSS must use var(--color-<token>) or an existing',
            'var(--risu-theme-<token>) bridge, never undefined bare aliases.',
        ].join(' ')).toEqual([])
    })

    test('exposes a dedicated theme-token contract check command', () => {
        const packageJson = JSON.parse(readFileSync(
            join(process.cwd(), 'package.json'), 'utf8'
        )) as { scripts?: Record<string, string> }

        expect(packageJson.scripts?.['check:theme-tokens']).toBe(
            'vitest run src/lib/UI/GUI/ThemeTokenContract.test.ts'
        )
    })
})
