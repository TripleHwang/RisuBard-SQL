import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const bootstrapSource = readFileSync(
    resolve(process.cwd(), 'src/ts/bootstrap.ts'),
    'utf8'
)

describe('global browser error handling', () => {
    test('ignores error events without an error or message', () => {
        expect(bootstrapSource).toMatch(
            /const error = event\.error \?\? event\.message[\s\S]*if \(!error\) return[\s\S]*alertError\(error\)/
        )
    })

    test('ignores benign ResizeObserver loop notifications', () => {
        expect(bootstrapSource).toMatch(
            /ResizeObserver loop completed with undelivered notifications\./
        )
        expect(bootstrapSource).toMatch(
            /ResizeObserver loop limit exceeded/
        )
        expect(bootstrapSource).toMatch(
            /if \(isIgnorableBrowserError\(error\)\) return/
        )
    })
})
