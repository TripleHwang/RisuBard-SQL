import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const legacyToken = ['jel', 'ly'].join('')
const excludedPrefixes = ['public/token/']

function ownedFiles(): string[] {
    return execFileSync('git', [
        'ls-files',
        '--cached',
        '--others',
        '--exclude-standard',
        '-z',
    ], { encoding: 'utf8' })
        .split('\0')
        .filter(Boolean)
        .filter((path) => !excludedPrefixes.some((prefix) => path.startsWith(prefix)))
        .filter(existsSync)
}

describe('brand boundary', () => {
    test('owned paths and UTF-8 text contain no legacy brand token', () => {
        const violations: string[] = []

        for (const path of ownedFiles()) {
            if (path.toLowerCase().includes(legacyToken)) {
                violations.push(`path:${path}`)
            }

            const content = readFileSync(path)
            if (!content.includes(0) && content.toString('utf8').toLowerCase().includes(legacyToken)) {
                violations.push(`content:${path}`)
            }
        }

        expect(violations).toEqual([])
    })
})
