import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')

/**
 * `requestImmediateSaveImpl` is assigned inside `saveDb`, and metadata-first
 * startup never calls `saveDb`. Left alone it stays at its `() => {}` default,
 * so all sixty-three `requestImmediateSave` call sites become no-ops -- and the
 * ones that await it and then act are acting on a save that never happened.
 *
 * Read from source rather than by driving the module: importing
 * `globalApi.svelte` pulls wasmoon and DOMPurify and needs a DOM, which is why
 * the sibling startup contract in bootstrapStartup.test.ts is written this way
 * too.
 */
describe('immediate save in metadata-first mode', () => {
    it('is assigned by startMetadataPersistence, not only by saveDb', () => {
        const metadata = source.indexOf('export async function startMetadataPersistence')
        const legacy = source.indexOf('export async function saveDb')
        expect(metadata).toBeGreaterThan(-1)

        const block = source.slice(metadata, legacy > metadata ? legacy : undefined)
        expect(block).toContain('requestImmediateSaveImpl = async (options)')
        // The audit is what turns a mutation into a dirty mark. Flushing without
        // it commits whatever happened to be marked already and reports success
        // for the change the caller is actually asking about.
        expect(block).toMatch(/auditSqlCompatibilityDatabase\(getDatabase\(\)\)[\s\S]*flushSqlDirtyChanges\(\)/)
        // `options` was ignored here, so a failed commit rejected regardless and
        // every `void requestImmediateSave()` site turned one transient failure
        // into an unhandled rejection, which bootstrap shows as a modal.
        expect(block).toContain('if (options?.rejectOnFailure) throw error')
    })
})
