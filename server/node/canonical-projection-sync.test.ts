import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createUserDataRepository } = require('./user-data-repository.cjs')
let createCanonicalProjectionSync: any
try {
    ({ createCanonicalProjectionSync } = require('./canonical-projection-sync.cjs'))
} catch {
    createCanonicalProjectionSync = undefined
}

const roots: string[] = []
afterEach(() => {
    roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true }))
})

describe('canonical projection sync', () => {
    it('loads externally edited canonical files and advances the accepted revision only after adoption', () => {
        expect(createCanonicalProjectionSync).toBeTypeOf('function')
        if (!createCanonicalProjectionSync) return

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-projection-sync-'))
        roots.push(dataRoot)
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase({
            language: 'ko',
            botPresets: [{ id: 'preset-1', name: 'Original' }],
            modules: [], personas: [], loreBook: [], characters: [],
        }, { mode: 'merge' })

        let acceptedRevision: string | null = null
        const sync = createCanonicalProjectionSync({
            repository,
            readAcceptedRevision: () => acceptedRevision,
            writeAcceptedRevision: (revision: string) => { acceptedRevision = revision },
        })

        const initial = sync.loadExternalChanges()
        expect(initial?.database.botPresets[0].name).toBe('Original')
        expect(acceptedRevision).toBeNull()
        sync.accept(initial.revision)
        expect(sync.hasExternalChanges).toBeTypeOf('function')
        if (!sync.hasExternalChanges) return
        expect(sync.hasExternalChanges()).toBe(false)
        expect(sync.loadExternalChanges()).toBeNull()

        const presetPath = path.join(dataRoot, 'presets', 'preset-1.json')
        const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'))
        preset.name = 'Externally edited'
        fs.writeFileSync(presetPath, `${JSON.stringify(preset, null, 2)}\n`)

        expect(sync.hasExternalChanges()).toBe(true)
        const changed = sync.loadExternalChanges()
        expect(changed?.database.botPresets[0].name).toBe('Externally edited')
        expect(acceptedRevision).toBe(initial.revision)
        sync.accept(changed.revision)
        expect(acceptedRevision).toBe(changed.revision)
        expect(sync.loadExternalChanges()).toBeNull()
    })
})
