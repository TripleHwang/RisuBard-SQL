import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zipSync, strToU8 } from 'fflate'

describe('importSaveFolderZip', () => {
    it('extracts strict hexadecimal save entries and publishes them once', async () => {
        const { importSaveFolderZip } = await import('./save-folder-zip-import.cjs')
        const root = await mkdtemp(join(tmpdir(), 'risu-save-zip-'))
        try {
            const database = Buffer.from('database/database.bin').toString('hex')
            const asset = Buffer.from('assets/example.png').toString('hex')
            const archive = zipSync({ [`save/${database}`]: strToU8('db'), [`save/${asset}`]: strToU8('png') })
            const archivePath = join(root, 'save.zip')
            await writeFile(archivePath, archive)
            const calls: any[] = []
            const result = await importSaveFolderZip({ archivePath, stagingRoot: root, replaceAllFromFiles: async (entries: any[]) => calls.push(entries) })
            expect(result).toEqual({ imported: 2 })
            expect(calls).toHaveLength(1)
            expect(calls[0].map(entry => entry.key).sort()).toEqual(['assets/example.png', 'database/database.bin'])
        } finally { await rm(root, { recursive: true, force: true }) }
    })

    it('rejects duplicate decoded keys before replacing the old manifest', async () => {
        const { importSaveFolderZip } = await import('./save-folder-zip-import.cjs')
        const root = await mkdtemp(join(tmpdir(), 'risu-save-zip-'))
        try {
            const database = Buffer.from('database/database.bin').toString('hex')
            const archive = zipSync({ [`one/${database}`]: strToU8('a'), [`two/${database}`]: strToU8('b') })
            const archivePath = join(root, 'save.zip')
            await writeFile(archivePath, archive)
            await expect(importSaveFolderZip({ archivePath, stagingRoot: root, replaceAllFromFiles: async () => { throw new Error('must not publish') } }))
                .rejects.toMatchObject({ code: 'INVALID_SAVE_FOLDER_ZIP' })
        } finally { await rm(root, { recursive: true, force: true }) }
    })
})
