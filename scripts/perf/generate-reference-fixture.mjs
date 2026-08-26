import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import fixture from '../../server/node/performance-fixture.cjs'

function numberFlag(name, fallback) {
    const index = process.argv.indexOf(`--${name}`)
    if (index === -1) return fallback
    const value = Number(process.argv[index + 1])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`)
    return value
}

const outputIndex = process.argv.indexOf('--output')
if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
    throw new Error('Usage: node scripts/perf/generate-reference-fixture.mjs --output <empty-directory> [--characters N --messages N --logical-asset-bytes N]')
}
const output = resolve(process.argv[outputIndex + 1])
if (existsSync(output) && readdirSync(output).length > 0) throw new Error('Output directory must be empty')

const summary = fixture.createReferenceFixture(output, {
    characters: numberFlag('characters', 200),
    messages: numberFlag('messages', 20_000),
    logicalAssetBytes: numberFlag('logical-asset-bytes', 20 * 1024 ** 3),
})
process.stdout.write(`Created generated reference fixture: ${summary.characters} characters, ${summary.messages} messages, ${summary.logicalAssetBytes} logical asset bytes\n`)
